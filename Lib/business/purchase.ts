import mongoose from "mongoose";
import BizPurchase, { IBizPurchase } from "../../Models/BizPurchase";
import BizItem, { IBizItem } from "../../Models/BizItem";
import BizStockLot from "../../Models/BizStockLot";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizAccount from "../../Models/BizAccount";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { postVoucher, PostLine } from "./voucher";
import { consume, itemRoles, receive } from "./inventory";

// Purchases from suppliers (2026-10, docs/business-suite.md phase 2), after
// nexxacrm's purchase flow: a draft is written, receiving it puts every line
// in stock as a batch (lot number and expiry) and books the payable; payments
// settle the payable from cash or bank; a receipt is undone only while none
// of its batches has been touched.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const round = (n: number) => Math.round(Number(n) || 0);

const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const BizCounter =
  (mongoose.models.BizCounter as mongoose.Model<{ _id: string; seq: number }>) ||
  mongoose.model<{ _id: string; seq: number }>("BizCounter", CounterSchema);

export const nextPurchaseNumber = async (owner: BizOwner) => {
  const row = await BizCounter.findOneAndUpdate(
    { _id: `purchase:${owner.kind}:${owner.id || ""}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return row!.seq;
};

// subtotal, total and the checks every saved purchase passes
export const totals = (p: Pick<IBizPurchase, "lines" | "discount" | "tax">) => {
  const subtotal = round(p.lines.reduce((s, l) => s + l.qty * l.unitCost, 0));
  const discount = Math.min(round(p.discount), subtotal);
  const tax = round(p.tax);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
};

const itemsOf = async (owner: BizOwner, p: IBizPurchase) => {
  const items = await BizItem.find({ ...own(owner), _id: { $in: p.lines.map((l) => l.item) } }).lean<IBizItem[]>();
  const byId = new Map(items.map((i) => [String(i._id), i]));
  for (const l of p.lines) if (!byId.has(String(l.item))) throw new AppError("کالای این ردیف پیدا نشد", 400);
  return byId;
};

// The goods come in: one batch per line, at the line's cost net of its share
// of the discount, and one voucher - stock (and input VAT) against the
// supplier's payable.
export const receivePurchase = async (owner: BizOwner, purchaseId: unknown, userId?: unknown) => {
  const p = await BizPurchase.findOne({ ...own(owner), _id: purchaseId }).lean<IBizPurchase>();
  if (!p) throw new AppError("خرید پیدا نشد", 404);
  if (p.status !== "draft") throw new AppError("فقط پیش‌نویس خرید را می‌توان دریافت کرد", 400);
  if (!p.lines.length) throw new AppError("خرید بدون ردیف کالا است", 400);
  const items = await itemsOf(owner, p);
  const t = totals(p);
  // the discount spreads over the lines by value
  const factor = t.subtotal ? (t.subtotal - t.discount) / t.subtotal : 1;
  const date = p.date || new Date();
  const byRole = new Map<string, number>();
  let booked = 0;
  for (const [i, l] of p.lines.entries()) {
    const item = items.get(String(l.item))!;
    const unitCost = l.unitCost * factor;
    const move = await receive({
      owner,
      item,
      qty: l.qty,
      unitCost,
      lotNo: l.lotNo,
      expiry: l.expiry || null,
      kind: "purchase",
      ref: `po:${p._id}:${i}`,
      date,
      createdBy: userId,
    });
    const role = itemRoles(item).asset;
    byRole.set(role, (byRole.get(role) || 0) + move.value);
    booked += move.value;
  }
  // rounding the batches' cost may leave a toman or two: it stays with the
  // first stock account so the voucher meets the invoice exactly
  const net = t.subtotal - t.discount;
  const first = byRole.keys().next().value as string;
  byRole.set(first, (byRole.get(first) || 0) + (net - booked));
  const lines: PostLine[] = [...byRole].map(([role, v]) => ({ role, debit: v }));
  if (t.tax) lines.push({ role: "vatReceivable", debit: t.tax });
  lines.push({ role: "payable", credit: t.total });
  if (t.total > 0)
    await postVoucher(owner, {
      ref: `po:${p._id}`,
      date,
      description: "خرید کالا از تأمین‌کننده",
      source: { type: "purchase", id: p._id },
      lines,
    });
  await BizPurchase.updateOne({ _id: p._id }, { $set: { ...t, status: "received", receivedAt: new Date() } });
  return BizPurchase.findById(p._id).lean();
};

// A payment to the supplier from cash, bank or the Noyan wallet.
export const payPurchase = async (
  owner: BizOwner,
  purchaseId: unknown,
  input: { amount: number; via: string; date?: Date; note?: string },
  userId?: unknown,
) => {
  const p = await BizPurchase.findOne({ ...own(owner), _id: purchaseId }).lean<IBizPurchase>();
  if (!p) throw new AppError("خرید پیدا نشد", 404);
  if (p.status !== "received") throw new AppError("پرداخت فقط برای خرید دریافت‌شده ثبت می‌شود", 400);
  const amount = round(input.amount);
  const remaining = p.total - p.paid;
  if (!(amount > 0) || amount > remaining) throw new AppError("مبلغ پرداخت بیشتر از مانده‌ی بدهی این خرید است", 400);
  const via = await BizAccount.findOne({ ...ownerFilter(owner), _id: input.via }).lean();
  if (!via || via.type !== "asset" || via.level !== "detail")
    throw new AppError("پرداخت یا دریافت فقط از صندوق، بانک یا کیف پول ممکن است", 400);
  const paymentId = new mongoose.Types.ObjectId();
  // claim the amount first, so two payments at once cannot overpay
  const res = await BizPurchase.updateOne(
    { _id: p._id, paid: p.paid },
    {
      $inc: { paid: amount },
      $push: { payments: { _id: paymentId, amount, via: via._id, date: input.date || new Date(), note: input.note } },
    },
  );
  if (!res.modifiedCount) throw new AppError("این خرید هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  await postVoucher(owner, {
    ref: `popay:${paymentId}`,
    date: input.date || new Date(),
    description: "پرداخت به تأمین‌کننده",
    source: { type: "purchase", id: p._id },
    lines: [
      { role: "payable", debit: amount },
      { accountId: via._id, credit: amount },
    ],
    createdBy: userId,
  });
  return BizPurchase.findById(p._id).lean();
};

// A draft is dropped; a receipt is undone - its batches leave stock and the
// voucher is reversed - only while no batch has been sold or used and
// nothing was paid on it.
export const cancelPurchase = async (owner: BizOwner, purchaseId: unknown, userId?: unknown) => {
  const p = await BizPurchase.findOne({ ...own(owner), _id: purchaseId }).lean<IBizPurchase>();
  if (!p) throw new AppError("خرید پیدا نشد", 404);
  if (p.status === "cancelled") return p;
  if (p.status === "draft") {
    await BizPurchase.updateOne({ _id: p._id }, { $set: { status: "cancelled" } });
    return BizPurchase.findById(p._id).lean();
  }
  if (p.paid > 0) throw new AppError("برای این خرید پرداخت ثبت شده و لغو نمی‌شود", 400);
  const refs = p.lines.map((_, i) => `po:${p._id}:${i}`);
  const lots = await BizStockLot.find({ ...own(owner), ref: { $in: refs } }).lean();
  if (lots.some((l) => l.qty !== l.received))
    throw new AppError("بخشی از کالای این خرید فروخته یا مصرف شده و لغو نمی‌شود", 400);
  const items = await itemsOf(owner, p);
  for (const [i, l] of p.lines.entries()) {
    const lot = lots.find((x) => x.ref === refs[i]);
    if (!lot) continue;
    await consume({
      owner,
      item: items.get(String(l.item))!,
      qty: lot.received,
      kind: "purchaseReturn",
      ref: `poc:${p._id}:${i}`,
      onlyLots: [lot._id],
      createdBy: userId,
    });
  }
  // the receipt's voucher, the other way round
  const original = await BizVoucher.findOne({ ...ownerFilter(owner), ref: `po:${p._id}` }).lean<IBizVoucher>();
  if (original?.lines?.length)
    await postVoucher(owner, {
      ref: `poc:${p._id}`,
      description: "لغو خرید کالا",
      source: { type: "purchase", id: p._id },
      lines: original.lines.map((l) => ({ accountId: String(l.account), debit: l.credit, credit: l.debit })),
    });
  await BizPurchase.updateOne({ _id: p._id }, { $set: { status: "cancelled" } });
  return BizPurchase.findById(p._id).lean();
};

// what each supplier is owed: received purchases minus payments
export const supplierBalances = async (owner: BizOwner) => {
  const rows = await BizPurchase.aggregate([
    { $match: { ...own(owner), status: "received" } },
    { $group: { _id: "$supplier", total: { $sum: "$total" }, paid: { $sum: "$paid" }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { total: r.total, paid: r.paid, due: r.total - r.paid, count: r.count }]));
};
