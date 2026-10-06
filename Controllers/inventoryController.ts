import { tehranNoonOf } from "../Lib/tehranTime";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import mongoose, { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizItem, { bizItemKinds, IBizItem } from "../Models/BizItem";
import BizStockMove, { bizMoveKinds } from "../Models/BizStockMove";
import BizSupplier from "../Models/BizSupplier";
import BizPurchase, { bizPurchaseStatuses, IBizPurchase } from "../Models/BizPurchase";
import BizAccount from "../Models/BizAccount";
import { BizOwner, displayName, ensureChart, ownerFilter } from "../Lib/business/coa";
import { currentLocale } from "../Lib/i18n/requestContext";
import { consume, itemLots, itemRoles, itemsView, postMoveVoucher, receive } from "../Lib/business/inventory";
import {
  cancelPurchase,
  nextPurchaseNumber,
  payPurchase,
  voidPurchasePayment,
  receivePurchase,
  supplierBalances,
  totals,
} from "../Lib/business/purchase";
import { OwnerOf } from "./businessController";

// Noyan Business inventory and purchasing API (2026-10, under /<panel>/inv):
// items with their batches and the reorder suggestion, the kardex, opening
// stock / use / stock count, suppliers and purchases. Reading needs the
// panel's readInventory, writing manageInventory; the plan module
// "inventory" opens it (Routers/inventoryRoutes.ts).

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .nullable();
// noon of the Tehran day (Lib/tehranTime.ts)
const dateOf = (s?: string | null) => (s ? tehranNoonOf(s) : undefined);
const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const itemBody = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(bizItemKinds).default("goods"),
  // a pharmacy's drug class (2026-10): its own inventory / cost account;
  // set when the item is made (stock already booked stays where it is)
  itemClass: z.enum(["drug", "otc", "cosmetic"]).optional(),
  sku: z.string().trim().max(60).optional(),
  barcode: z.string().trim().max(60).optional(),
  unit: z.string().trim().max(30).optional(),
  reorderPoint: z.coerce.number().min(0).max(1e9).default(0),
  maxStock: z.coerce.number().min(0).max(1e9).default(0),
  isActive: z.boolean().optional(),
});

const supplierBody = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(30).optional(),
  economicCode: z.string().trim().max(30).optional(),
  address: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

const purchaseBody = z.object({
  supplier: z.string(),
  invoiceNo: z.string().trim().max(60).optional(),
  date: day,
  discount: z.coerce.number().min(0).max(1e13).default(0),
  tax: z.coerce.number().min(0).max(1e13).default(0),
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        item: z.string(),
        qty: z.coerce.number().positive().max(1e9),
        unitCost: z.coerce.number().min(0).max(1e13),
        lotNo: z.string().trim().max(60).optional(),
        expiry: day,
      }),
    )
    .min(1)
    .max(200),
});

// a purchase's lines must name this owner's items, its supplier this owner's
const checkPurchase = async (owner: BizOwner, body: z.infer<typeof purchaseBody>) => {
  if (!isValidObjectId(body.supplier) || body.lines.some((l) => !isValidObjectId(l.item)))
    throw new AppError("کالای این ردیف پیدا نشد", 400);
  const [supplier, count] = await Promise.all([
    BizSupplier.findOne({ ...own(owner), _id: body.supplier }).lean(),
    BizItem.countDocuments({ ...own(owner), _id: { $in: [...new Set(body.lines.map((l) => l.item))] } }),
  ]);
  if (!supplier) throw new AppError("تأمین‌کننده پیدا نشد", 400);
  if (count !== new Set(body.lines.map((l) => l.item)).size) throw new AppError("کالای این ردیف پیدا نشد", 400);
  const lines = body.lines.map((l) => ({
    item: oid(l.item),
    qty: l.qty,
    unitCost: Math.round(l.unitCost),
    lotNo: l.lotNo || undefined,
    expiry: dateOf(l.expiry),
  }));
  const t = totals({ lines, discount: body.discount, tax: body.tax } as IBizPurchase);
  return {
    supplier: supplier._id,
    invoiceNo: body.invoiceNo,
    date: dateOf(body.date) || new Date(),
    note: body.note,
    lines,
    ...t,
  };
};

const populatePurchase = (q: any) =>
  q.populate("supplier", "name phone").populate("lines.item", "name unit kind").populate("payments.via", "code name role");

export const makeInventoryController = (ownerOf: OwnerOf) => ({
  // ---------------------------------------------------------------- overview
  getSummary: withOwner(ownerOf, async (owner, _req, res) => {
    const [items, balances, drafts] = await Promise.all([
      itemsView(owner),
      supplierBalances(owner),
      BizPurchase.countDocuments({ ...own(owner), status: "draft" }),
    ]);
    const active = items.filter((i) => i.isActive);
    res.status(200).json({
      message: "invSummary",
      data: {
        items: active.length,
        tracked: active.filter((i) => i.tracked).length,
        value: active.reduce((s, i) => s + i.value, 0),
        low: active.filter((i) => i.low).length,
        expired: active.filter((i) => i.expiredQty > 0).length,
        nearExpiry: active.filter((i) => i.nearQty > 0).length,
        payable: [...balances.values()].reduce((s, b) => s + b.due, 0),
        drafts,
      },
    });
  }),

  // the accounts a supplier is paid from: cash, bank and the Noyan wallet
  // with any sub-account opened under them (so purchasing works without the
  // accounting page)
  getPayAccounts: withOwner(ownerOf, async (owner, _req, res) => {
    await ensureChart(owner);
    const rows = await BizAccount.find({
      ...ownerFilter(owner),
      type: "asset",
      level: "detail",
      $or: [{ role: { $in: ["cash", "bank", "noyanWallet"] } }, { parentCode: "11", role: { $exists: false } }],
    })
      .sort({ code: 1 })
      .select("code name role")
      .lean();
    res.status(200).json({
      message: "invPayAccounts",
      data: rows.map((a) => ({ ...a, name: displayName(a, currentLocale()) })),
    });
  }),

  // ---------------------------------------------------------------- items
  getItems: withOwner(ownerOf, async (owner, _req, res) => {
    res.status(200).json({ message: "invItems", data: await itemsView(owner) });
  }),

  createItem: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = itemBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام کالا را بنویسید", 400);
    // a pharmacy's goods are its catalog products; it adds supplies by hand
    if (owner.kind === "pharmacy" && parsed.data.kind === "goods")
      throw new AppError("کالاهای فروشی داروخانه از محصولات خودش ساخته می‌شوند؛ اینجا فقط ملزومات مصرفی اضافه می‌شود", 400);
    const item = await BizItem.create({ ...own(owner), ...parsed.data, unit: parsed.data.unit || "" });
    res.status(201).json({ message: "invCreateItem", data: item });
  }),

  updateItem: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = itemBody.partial().safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.itemId)) throw new BadInputError();
    const item = await BizItem.findOne({ ...own(owner), _id: req.params.itemId });
    if (!item) throw new NotFoundError();
    const { kind, name, itemClass, ...rest } = parsed.data;
    // the drug class moves its stock account: only before the first receipt
    if (itemClass && itemClass !== item.itemClass) {
      if (item.tracked) throw new AppError("نوع کالایی که موجودی دارد یا محصول فروشگاه است تغییر نمی‌کند", 400);
      item.itemClass = itemClass;
    }
    // a catalog product keeps its name and stays goods; a tracked item keeps
    // its kind (its value already sits in that account)
    if (!item.product && name) item.name = name;
    if (kind && kind !== item.kind) {
      if (item.product || item.tracked) throw new AppError("نوع کالایی که موجودی دارد یا محصول فروشگاه است تغییر نمی‌کند", 400);
      item.kind = kind;
    }
    Object.assign(item, rest);
    await item.save();
    res.status(200).json({ message: "invUpdateItem", data: item });
  }),

  getLots: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.itemId)) throw new NotFoundError();
    res.status(200).json({ message: "invLots", data: await itemLots(owner, req.params.itemId) });
  }),

  // ---------------------------------------------------------------- stock
  // opening stock, use of supplies and the stock count
  stockEntry: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        kind: z.enum(["opening", "use", "count"]),
        item: z.string(),
        qty: z.coerce.number().min(0).max(1e9),
        unitCost: z.coerce.number().min(0).max(1e13).optional(),
        lotNo: z.string().trim().max(60).optional(),
        expiry: day,
        date: day,
        note: z.string().trim().max(300).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(parsed.data.item)) throw new AppError("کالا و مقدار را وارد کنید", 400);
    const b = parsed.data;
    const item = await BizItem.findOne({ ...own(owner), _id: b.item }).lean<IBizItem>();
    if (!item) throw new NotFoundError();
    const roles = itemRoles(item);
    const ref = `${b.kind}:${new mongoose.Types.ObjectId()}`;
    const date = dateOf(b.date) || new Date();
    const base = { owner, item, ref, date, note: b.note, createdBy: req.user?._id };
    let move;
    if (b.kind === "opening") {
      if (!(b.qty > 0)) throw new AppError("مقدار ورود به انبار باید بیشتر از صفر باشد", 400);
      move = await receive({ ...base, kind: "opening", qty: b.qty, unitCost: b.unitCost ?? item.lastCost, lotNo: b.lotNo, expiry: dateOf(b.expiry) });
      await postMoveVoucher(owner, item, move, "openingBalance", "موجودی اول دوره‌ی انبار");
    } else if (b.kind === "use") {
      if (item.kind !== "supply") throw new AppError("مصرف فقط برای ملزومات مصرفی ثبت می‌شود؛ کالای فروشی با فروش کم می‌شود", 400);
      if (!(b.qty > 0)) throw new AppError("مقدار خروج از انبار باید بیشتر از صفر باشد", 400);
      move = await consume({ ...base, kind: "use", qty: b.qty });
      await postMoveVoucher(owner, item, move, roles.expense, "مصرف ملزومات");
    } else {
      // the count: qty is what is on the shelf; the difference is a surplus
      // (a batch at the last cost) or a shortage (out by FEFO)
      const lots = await itemLots(owner, String(item._id));
      const stock = lots.reduce((s, l) => s + l.qty, 0);
      const diff = b.qty - stock;
      if (!diff) return res.status(200).json({ message: "invStockEntry", data: null });
      move =
        diff > 0
          ? await receive({ ...base, kind: "adjustIn", qty: diff, unitCost: b.unitCost ?? item.lastCost, lotNo: b.lotNo, expiry: dateOf(b.expiry) })
          : await consume({ ...base, kind: "adjustOut", qty: -diff });
      await postMoveVoucher(owner, item, move, "inventoryVariance", diff > 0 ? "اضافه‌ی انبارگردانی" : "کسری انبارگردانی");
    }
    res.status(201).json({ message: "invStockEntry", data: move });
  }),

  getMoves: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = page
      .extend({ item: z.string().optional(), kind: z.enum(bizMoveKinds).optional() })
      .safeParse(req.query);
    if (!parsed.success || (parsed.data.item && !isValidObjectId(parsed.data.item))) throw new BadInputError();
    const { item, kind, page: p, limit } = parsed.data;
    const filter = { ...own(owner), ...(item ? { item: oid(item) } : {}), ...(kind ? { kind } : {}) };
    const [items, total] = await Promise.all([
      BizStockMove.find(filter)
        .sort({ date: -1, _id: -1 })
        .skip((p - 1) * limit)
        .limit(limit)
        .populate("item", "name unit kind")
        .lean(),
      BizStockMove.countDocuments(filter),
    ]);
    res.status(200).json({ message: "invMoves", data: { items, total, page: p, pages: Math.max(1, Math.ceil(total / limit)) } });
  }),

  // ---------------------------------------------------------------- suppliers
  getSuppliers: withOwner(ownerOf, async (owner, _req, res) => {
    const [rows, balances] = await Promise.all([
      BizSupplier.find(own(owner)).sort({ name: 1 }).lean(),
      supplierBalances(owner),
    ]);
    res.status(200).json({
      message: "invSuppliers",
      data: rows.map((s) => ({ ...s, ...(balances.get(String(s._id)) || { total: 0, paid: 0, due: 0, count: 0 }) })),
    });
  }),

  createSupplier: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = supplierBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام تأمین‌کننده را بنویسید", 400);
    const supplier = await BizSupplier.create({ ...own(owner), ...parsed.data });
    res.status(201).json({ message: "invCreateSupplier", data: supplier });
  }),

  updateSupplier: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = supplierBody.partial().safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.supplierId)) throw new AppError("نام تأمین‌کننده را بنویسید", 400);
    const supplier = await BizSupplier.findOneAndUpdate(
      { ...own(owner), _id: req.params.supplierId },
      { $set: parsed.data },
      { new: true },
    ).lean();
    if (!supplier) throw new NotFoundError();
    res.status(200).json({ message: "invUpdateSupplier", data: supplier });
  }),

  // ---------------------------------------------------------------- purchases
  getPurchases: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = page
      .extend({ status: z.enum(bizPurchaseStatuses).optional(), supplier: z.string().optional() })
      .safeParse(req.query);
    if (!parsed.success || (parsed.data.supplier && !isValidObjectId(parsed.data.supplier))) throw new BadInputError();
    const { status, supplier, page: p, limit } = parsed.data;
    const filter = { ...own(owner), ...(status ? { status } : {}), ...(supplier ? { supplier: oid(supplier) } : {}) };
    const [items, total] = await Promise.all([
      populatePurchase(
        BizPurchase.find(filter)
          .sort({ date: -1, number: -1 })
          .skip((p - 1) * limit)
          .limit(limit),
      ).lean(),
      BizPurchase.countDocuments(filter),
    ]);
    res.status(200).json({ message: "invPurchases", data: { items, total, page: p, pages: Math.max(1, Math.ceil(total / limit)) } });
  }),

  getPurchase: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.purchaseId)) throw new NotFoundError();
    const p = await populatePurchase(BizPurchase.findOne({ ...own(owner), _id: req.params.purchaseId })).lean();
    if (!p) throw new NotFoundError();
    res.status(200).json({ message: "invPurchase", data: p });
  }),

  createPurchase: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = purchaseBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("تأمین‌کننده و دست‌کم یک ردیف کالا با مقدار و قیمت لازم است", 400);
    const data = await checkPurchase(owner, parsed.data);
    const purchase = await BizPurchase.create({
      ...own(owner),
      ...data,
      number: await nextPurchaseNumber(owner),
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "invCreatePurchase", data: purchase });
  }),

  updatePurchase: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = purchaseBody.safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.purchaseId))
      throw new AppError("تأمین‌کننده و دست‌کم یک ردیف کالا با مقدار و قیمت لازم است", 400);
    const data = await checkPurchase(owner, parsed.data);
    const purchase = await BizPurchase.findOneAndUpdate(
      { ...own(owner), _id: req.params.purchaseId, status: "draft" },
      { $set: data },
      { new: true },
    ).lean();
    if (!purchase) throw new AppError("فقط پیش‌نویس خرید ویرایش می‌شود", 400);
    res.status(200).json({ message: "invUpdatePurchase", data: purchase });
  }),

  receivePurchase: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.purchaseId)) throw new NotFoundError();
    const data = await receivePurchase(owner, req.params.purchaseId, req.user?._id);
    res.status(200).json({ message: "invReceivePurchase", data });
  }),

  payPurchase: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        amount: z.coerce.number().positive().max(1e13),
        via: z.string(),
        date: day,
        note: z.string().trim().max(300).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.purchaseId) || !isValidObjectId(parsed.data.via))
      throw new AppError("مبلغ و حساب پرداخت را مشخص کنید", 400);
    const data = await payPurchase(
      owner,
      req.params.purchaseId,
      { ...parsed.data, date: dateOf(parsed.data.date) },
      req.user?._id,
    );
    res.status(200).json({ message: "invPayPurchase", data });
  }),

  voidPurchasePayment: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ reason: z.string().trim().max(500).optional() }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.purchaseId) || !isValidObjectId(req.params.paymentId)) throw new NotFoundError();
    const data = await voidPurchasePayment(owner, req.params.purchaseId, req.params.paymentId, parsed.data.reason || "");
    res.status(200).json({ message: "invVoidPurchasePayment", data });
  }),

  cancelPurchase: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.purchaseId)) throw new NotFoundError();
    const data = await cancelPurchase(owner, req.params.purchaseId, req.user?._id);
    res.status(200).json({ message: "invCancelPurchase", data });
  }),
});
