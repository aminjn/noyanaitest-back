import mongoose from "mongoose";
import BizItem, { IBizItem } from "../../Models/BizItem";
import BizStockLot, { IBizStockLot } from "../../Models/BizStockLot";
import BizStockMove, { BizMoveKind, IBizStockMove } from "../../Models/BizStockMove";
import ProductSeller from "../../Models/ProductSeller";
import Product from "../../Models/Product";
import ProductPackage from "../../Models/ProductPackage";
import Order from "../../Models/Order";
import AppError from "../AppError";
import { BizOwner } from "./coa";
import { postVoucher } from "./voucher";
import { reverseRef } from "./finance";

// Noyan Business inventory (2026-10, docs/business-suite.md phase 2), after
// nexxacrm's lib/lot-core.ts (FEFO), fifo-core.ts (cost per batch) and
// reorder-core.ts. Stock is the sum of batches (BizStockLot); every change
// is one movement (BizStockMove, the kardex) and, where it changes the
// value of stock, one voucher in the owner's books.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const ownerOf = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });

// which accounts an item's value lives in and goes to
// (2026-10) a pharmacy's OTC and cosmetics keep their own inventory and
// cost of sales; a profile without them falls back to inventory / cogs
// (Lib/business/coa.ts ROLE_FALLBACK)
export const itemRoles = (item: Pick<IBizItem, "kind" | "itemClass">) =>
  item.kind === "supply"
    ? { asset: "supplies", expense: "suppliesExpense" }
    : item.itemClass === "otc"
      ? { asset: "inventoryOtc", expense: "cogsOtc" }
      : item.itemClass === "cosmetic"
        ? { asset: "inventoryCosmetic", expense: "cogsCosmetic" }
        : { asset: "inventory", expense: "cogs" };

// FEFO: the batch that expires first goes first; batches with no expiry
// after them, oldest first (nexxacrm sortFefo)
const fefo = (a: IBizStockLot, b: IBizStockLot) => {
  const ea = a.expiry ? a.expiry.getTime() : null;
  const eb = b.expiry ? b.expiry.getTime() : null;
  if (ea == null && eb == null) return a.receivedAt.getTime() - b.receivedAt.getTime();
  if (ea == null) return 1;
  if (eb == null) return -1;
  if (ea !== eb) return ea - eb;
  return a.receivedAt.getTime() - b.receivedAt.getTime();
};

export type ReceiveInput = {
  owner: BizOwner;
  item: IBizItem;
  qty: number;
  unitCost: number;
  lotNo?: string;
  expiry?: Date | null;
  kind: Extract<BizMoveKind, "opening" | "purchase" | "adjustIn" | "saleReturn">;
  ref: string;
  date?: Date;
  note?: string;
  createdBy?: unknown;
};

// A batch comes in. Idempotent by ref.
export const receive = async (input: ReceiveInput): Promise<IBizStockMove> => {
  const own = ownerOf(input.owner);
  const existing = await BizStockMove.findOne({ ...own, ref: input.ref }).lean<IBizStockMove>();
  if (existing) return existing;
  if (!(input.qty > 0)) throw new AppError("مقدار ورود به انبار باید بیشتر از صفر باشد", 400);
  // a batch keeps its exact cost (a purchase discount spreads into it), so
  // stock value and the books stay equal; only the move's value is rounded
  const unitCost = Math.max(0, Number(input.unitCost) || 0);
  const lot = await BizStockLot.create({
    ...own,
    item: input.item._id,
    lotNo: input.lotNo || undefined,
    expiry: input.expiry || undefined,
    qty: input.qty,
    received: input.qty,
    unitCost,
    receivedAt: input.date || new Date(),
    ref: input.ref,
  });
  const move = await BizStockMove.create({
    ...own,
    item: input.item._id,
    kind: input.kind,
    qty: input.qty,
    unitCost,
    value: Math.round(input.qty * unitCost),
    lots: [{ lot: lot._id, qty: input.qty }],
    ref: input.ref,
    note: input.note,
    date: input.date || new Date(),
    createdBy: input.createdBy,
  });
  await BizItem.updateOne(
    { _id: input.item._id },
    { $set: { tracked: true, ...(unitCost > 0 ? { lastCost: Math.round(unitCost) } : {}) } },
  );
  return move.toObject() as IBizStockMove;
};

export type ConsumeInput = {
  owner: BizOwner;
  item: IBizItem;
  qty: number;
  kind: Extract<BizMoveKind, "sale" | "use" | "adjustOut" | "purchaseReturn">;
  ref: string;
  date?: Date;
  note?: string;
  createdBy?: unknown;
  // only from these batches (undoing a receipt)
  onlyLots?: mongoose.Types.ObjectId[];
};

// Stock goes out, earliest expiry first; its cost is what those batches
// cost. What no batch covers is a shortage valued at the last cost (stock
// may run short - a sale is never refused for it - and the count fixes it).
// Idempotent by ref.
export const consume = async (input: ConsumeInput): Promise<IBizStockMove> => {
  const own = ownerOf(input.owner);
  const existing = await BizStockMove.findOne({ ...own, ref: input.ref }).lean<IBizStockMove>();
  if (existing) return existing;
  if (!(input.qty > 0)) throw new AppError("مقدار خروج از انبار باید بیشتر از صفر باشد", 400);
  const lots = (
    await BizStockLot.find({
      ...own,
      item: input.item._id,
      qty: { $gt: 0 },
      ...(input.onlyLots ? { _id: { $in: input.onlyLots } } : {}),
    }).lean<IBizStockLot[]>()
  ).sort(fefo);
  let need = input.qty;
  let cost = 0;
  const taken: { lot: mongoose.Types.ObjectId; qty: number }[] = [];
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.qty, need);
    // the lot may have moved since it was read: take only what is there
    const res = await BizStockLot.updateOne({ _id: lot._id, qty: { $gte: take } }, { $inc: { qty: -take } });
    if (!res.modifiedCount) continue;
    taken.push({ lot: lot._id, qty: take });
    cost += take * lot.unitCost;
    need -= take;
  }
  const shortage = Math.max(0, need);
  cost += shortage * (input.item.lastCost || 0);
  const move = await BizStockMove.create({
    ...own,
    item: input.item._id,
    kind: input.kind,
    qty: -input.qty,
    unitCost: input.qty ? Math.round(cost / input.qty) : 0,
    value: -Math.round(cost),
    shortage: shortage || undefined,
    lots: taken,
    ref: input.ref,
    note: input.note,
    date: input.date || new Date(),
    createdBy: input.createdBy,
  });
  return move.toObject() as IBizStockMove;
};

// ---------------------------------------------------------------- items

// A pharmacy's stock items are the products it sells: one item per
// ProductSeller, made the first time its inventory is opened (and kept in
// step after that), so a sale knows what to deduct.
export const syncPharmacyItems = async (owner: BizOwner) => {
  if (owner.kind !== "pharmacy" || !owner.id) return;
  const sellers = await ProductSeller.find({ seller: owner.id }).select("product").lean();
  if (!sellers.length) return;
  const have = await BizItem.find({ ...ownerOf(owner), product: { $exists: true } }).select("product").lean();
  const known = new Set(have.map((i) => String(i.product)));
  const missing = sellers.filter((s) => s.product && !known.has(String(s.product)));
  if (!missing.length) return;
  const products = await Product.find({ _id: { $in: missing.map((m) => m.product) } }).select("name prescriptionRequired").lean();
  await BizItem.insertMany(
    // (2026-10) a product the admin sells without prescription starts in
    // the OTC class (its own stock, income and cost accounts); the owner
    // sets the rest on the item before its first receipt
    products.map((p) => ({ ...ownerOf(owner), name: p.name, kind: "goods", product: p._id, unit: "", ...(p.prescriptionRequired === "otc" ? { itemClass: "otc" } : {}) })),
    { ordered: false },
  ).catch((err) => {
    if (err?.code !== 11000 && !err?.writeErrors) throw err;
  });
};

const DAY = 24 * 60 * 60 * 1000;
export const NEAR_EXPIRY_DAYS = 90;

// nexxacrm suggestReorder: fill up to maxStock, or past the reorder point
// by a month of real demand, or cover a month of demand; nothing to go on
// means no suggestion
export const suggestReorder = (stock: number, reorderPoint: number, maxStock: number, monthlyDemand: number) => {
  const demand = Math.max(0, Math.ceil(monthlyDemand));
  let target = 0;
  if (maxStock > 0) target = maxStock;
  else if (reorderPoint > 0) target = reorderPoint + demand;
  else if (monthlyDemand > 0) target = demand;
  else return 0;
  return Math.max(0, Math.round(target - stock));
};

export type ItemView = IBizItem & {
  stock: number;
  value: number;
  nextExpiry: Date | null;
  expiredQty: number;
  nearQty: number;
  monthlyDemand: number;
  suggested: number;
  low: boolean;
};

// Every item with its stock, value, nearest expiry, a month's demand (the
// last 90 days of sales and use) and the purchase it suggests.
export const itemsView = async (owner: BizOwner): Promise<ItemView[]> => {
  await syncPharmacyItems(owner);
  const own = ownerOf(owner);
  const now = Date.now();
  const [items, lots, demand] = await Promise.all([
    BizItem.find(own).sort({ name: 1 }).lean<IBizItem[]>(),
    BizStockLot.find({ ...own, qty: { $gt: 0 } }).select("item qty unitCost expiry").lean<IBizStockLot[]>(),
    BizStockMove.aggregate([
      // a sale taken back (a voided invoice, a return) is no demand
      { $match: { ...own, kind: { $in: ["sale", "use", "saleReturn"] }, date: { $gte: new Date(now - 90 * DAY) } } },
      { $group: { _id: "$item", out: { $sum: { $multiply: ["$qty", -1] } } } },
    ]),
  ]);
  const byItem = new Map<string, IBizStockLot[]>();
  for (const l of lots) {
    const k = String(l.item);
    byItem.set(k, [...(byItem.get(k) || []), l]);
  }
  const demandOf = new Map<string, number>(demand.map((d) => [String(d._id), Math.max(0, d.out) / 3]));
  return items.map((item) => {
    const mine = byItem.get(String(item._id)) || [];
    const stock = mine.reduce((s, l) => s + l.qty, 0);
    const value = Math.round(mine.reduce((s, l) => s + l.qty * l.unitCost, 0));
    const dated = mine.filter((l) => l.expiry).sort((a, b) => a.expiry!.getTime() - b.expiry!.getTime());
    const expiredQty = dated.filter((l) => l.expiry!.getTime() < now).reduce((s, l) => s + l.qty, 0);
    const nearQty = dated
      .filter((l) => l.expiry!.getTime() >= now && l.expiry!.getTime() - now <= NEAR_EXPIRY_DAYS * DAY)
      .reduce((s, l) => s + l.qty, 0);
    const monthlyDemand = Math.round((demandOf.get(String(item._id)) || 0) * 10) / 10;
    const suggested = suggestReorder(stock, item.reorderPoint, item.maxStock, monthlyDemand);
    return {
      ...item,
      stock,
      value,
      nextExpiry: dated[0]?.expiry || null,
      expiredQty,
      nearQty,
      monthlyDemand,
      suggested,
      low: item.tracked && item.reorderPoint > 0 && stock <= item.reorderPoint,
    };
  });
};

// The batches of one item that still hold stock, earliest expiry first.
export const itemLots = async (owner: BizOwner, itemId: string) =>
  (await BizStockLot.find({ ...ownerOf(owner), item: itemId, qty: { $gt: 0 } }).lean<IBizStockLot[]>()).sort(fefo);

// ---------------------------------------------------------------- vouchers

// the books for a movement that changes the value of stock
export const postMoveVoucher = async (
  owner: BizOwner,
  item: IBizItem,
  move: IBizStockMove,
  counterRole: string,
  description: string,
) => {
  const value = Math.abs(move.value || 0);
  if (!value) return;
  const { asset } = itemRoles(item);
  const inbound = move.qty > 0;
  await postVoucher(owner, {
    ref: `stock:${move._id}`,
    date: move.date,
    description,
    source: { type: "stockMove", id: move._id },
    lines: inbound
      ? [
          { role: asset, debit: value, label: item.name },
          { role: counterRole, credit: value, label: item.name },
        ]
      : [
          { role: counterRole, debit: value, label: item.name },
          { role: asset, credit: value, label: item.name },
        ],
  });
};

// ---------------------------------------------------------------- sales

// A fulfilled order line of a pharmacy leaves its stock (2026-10): called
// by the ledger poster when the line's earning is posted. Only tracked
// items (with a receipt behind them) are deducted, so a pharmacy that does
// not keep stock here never goes negative. A package deducts each of its
// products.
export const deductOrderLine = async (owner: BizOwner, orderId: unknown, lineId: unknown) => {
  if (owner.kind !== "pharmacy") return;
  const order = await Order.findById(orderId).lean<Record<string, any>>();
  if (!order) return;
  const id = String((lineId as { _id?: unknown })?._id ?? lineId);
  const product = (order.products || []).find((l: any) => String(l._id) === id);
  const pack = (order.productPackages || []).find((l: any) => String(l._id) === id);
  let wanted: { product: unknown; qty: number }[] = [];
  if (product) {
    const seller = await ProductSeller.findById(product.item).select("product").lean();
    if (seller?.product) wanted = [{ product: seller.product, qty: product.qty || 1 }];
  } else if (pack) {
    const pkg = await ProductPackage.findById(pack.item).select("products").lean<{ products?: unknown[] }>();
    wanted = (pkg?.products || []).map((p) => ({ product: p, qty: pack.qty || 1 }));
  }
  for (const [i, w] of wanted.entries()) {
    const item = await BizItem.findOne({ ...ownerOf(owner), product: oid(w.product), tracked: true }).lean<IBizItem>();
    if (!item) continue;
    const move = await consume({
      owner,
      item,
      qty: w.qty,
      kind: "sale",
      ref: `sale:${order._id}:${id}:${i}`,
      date: new Date(),
    });
    await postMoveVoucher(owner, item, move, itemRoles(item).expense, "بهای تمام‌شده‌ی کالای فروش‌رفته");
  }
};

// ------------------------------------------------------- counter sales

// (2026-10) A manual invoice's stock lines: issuing it takes each sold item
// out of stock, earliest expiry first, and books its cost of sales (the
// pharmacy counter, where most of a pharmacy's sales happen - not only the
// site's orders). Idempotent by the line's ref.
export const sellInvoiceLines = async (
  owner: BizOwner,
  inv: { _id: unknown; date?: Date; number?: number; lines: { item?: unknown; qty: number; title?: string }[] },
  createdBy?: unknown,
) => {
  const ids = inv.lines.map((l) => l.item).filter((i) => i && mongoose.isValidObjectId(String(i)));
  if (!ids.length) return;
  const items = new Map(
    (await BizItem.find({ ...ownerOf(owner), _id: { $in: ids.map(oid) } }).lean<IBizItem[]>()).map((i) => [String(i._id), i]),
  );
  for (const [i, l] of inv.lines.entries()) {
    const item = l.item ? items.get(String(l.item)) : undefined;
    if (!item || !(l.qty > 0)) continue;
    const move = await consume({
      owner,
      item,
      qty: l.qty,
      kind: "sale",
      ref: `invsale:${inv._id}:${i}`,
      date: inv.date || new Date(),
      note: inv.number ? `#${inv.number}` : undefined,
      createdBy,
    });
    await postMoveVoucher(owner, item, move, itemRoles(item).expense, "بهای تمام‌شده‌ی کالای فروش‌رفته");
  }
};

// A voided invoice's stock lines come back into the very batches they left
// (their lot numbers and expiry), what ran short as a batch at the cost it
// was sold at, and the cost-of-sales voucher is reversed.
export const returnInvoiceLines = async (owner: BizOwner, inv: { _id: unknown; lines: { item?: unknown }[] }, createdBy?: unknown) => {
  const own = ownerOf(owner);
  for (const [i, l] of inv.lines.entries()) {
    if (!l.item) continue;
    const ref = `invsale:${inv._id}:${i}`;
    const sold = await BizStockMove.findOne({ ...own, ref }).lean<IBizStockMove>();
    if (!sold || (await BizStockMove.exists({ ...own, ref: `${ref}:void` }))) continue;
    const qty = Math.abs(sold.qty);
    const lots = [...(sold.lots || [])];
    let back = 0;
    for (const t of lots) {
      const lot = await BizStockLot.findOneAndUpdate({ _id: t.lot }, { $inc: { qty: t.qty } }, { new: true }).lean<IBizStockLot>();
      if (lot) back += t.qty * lot.unitCost;
    }
    const short = qty - lots.reduce((s, t) => s + t.qty, 0);
    if (short > 0) {
      const lot = await BizStockLot.create({
        ...own,
        item: sold.item,
        qty: short,
        received: short,
        unitCost: Math.max(0, (Math.abs(sold.value || 0) - back) / short),
        receivedAt: new Date(),
        ref: `${ref}:void`,
      });
      lots.push({ lot: lot._id, qty: short });
    }
    await BizStockMove.create({
      ...own,
      item: sold.item,
      kind: "saleReturn",
      qty,
      unitCost: sold.unitCost,
      value: Math.abs(sold.value || 0),
      lots,
      ref: `${ref}:void`,
      date: new Date(),
      createdBy,
    });
    await reverseRef(owner, `stock:${sold._id}`, "برگشت بهای تمام‌شده‌ی صورتحساب باطل‌شده");
  }
};
