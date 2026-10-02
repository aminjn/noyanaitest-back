import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import mongoose, { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizAccount, { BizOwnerKind, IBizAccount } from "../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../Models/BizVoucher";
import { BizOwner, displayName, ensureChart, ownerFilter } from "../Lib/business/coa";
import { buildLines, postVoucher } from "../Lib/business/voucher";
import { balanceSheet, incomeStatement, ledger, summary, trialBalance } from "../Lib/business/reports";
import { currentLocale } from "../Lib/i18n/requestContext";
import { voucherDescriptions } from "../Lib/business/voucherDescriptions";
import { SOURCE_LOCALE } from "../Lib/locales";

// an automatic voucher's description in the reader's language (a manual
// one is shown as typed)
const localizeDescription = <T extends { description?: string; kind?: string }>(v: T): T => {
  const locale = currentLocale();
  if (v.kind === "manual" || locale === SOURCE_LOCALE || !v.description) return v;
  return { ...v, description: voucherDescriptions[v.description]?.[locale] || v.description };
};

// Noyan Business accounting API (2026-10). One controller for every panel
// and the platform: the owner comes from the panel's middleware (req.doctor,
// req.pharmacy, ...) or is the platform for the super admin. Reading needs
// the panel's readFinance, writing its manageAccounting; the plan module
// "accounting" opens it (see Routers/businessRoutes.ts).

export type OwnerOf = (req: Request) => BizOwner | null;

export const ownerOfReq =
  (kind: BizOwnerKind): OwnerOf =>
  (req) => {
    if (kind === "platform") return { kind };
    const org = (req as unknown as Record<string, { _id?: unknown } | undefined>)[kind];
    return org?._id ? { kind, id: String(org._id) } : null;
  };

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const rangeSchema = z.object({ from: day, to: day });
const voucherBody = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  description: z.string().trim().min(2).max(500),
  lines: z
    .array(
      z.object({
        account: z.string(),
        label: z.string().max(300).optional(),
        debit: z.coerce.number().min(0).default(0),
        credit: z.coerce.number().min(0).default(0),
      }),
    )
    .min(2)
    .max(50),
});
const startOf = (s?: string) => (s ? new Date(`${s}T00:00:00`) : null);
const endOf = (s?: string) => (s ? new Date(`${s}T23:59:59.999`) : null);

const localizeAccount = <T extends Pick<IBizAccount, "name" | "code" | "role">>(a: T) => ({
  ...a,
  name: displayName(a, currentLocale()),
});

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner) return next(new NotFoundError());
    await fn(owner, req, res);
  });

export const makeBusinessController = (ownerOf: OwnerOf) => ({
  getSummary: withOwner(ownerOf, async (owner, _req, res) => {
    res.status(200).json({ message: "bizSummary", data: await summary(owner) });
  }),

  getAccounts: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const { rows } = await trialBalance(owner, startOf(parsed.data.from), endOf(parsed.data.to));
    res.status(200).json({ message: "bizAccounts", data: rows.map(localizeAccount) });
  }),

  createAccount: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ parentCode: z.string().min(1).max(20), name: z.string().trim().min(2).max(200) })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام حساب و حساب کل آن را مشخص کنید", 400);
    await ensureChart(owner);
    const parent = await BizAccount.findOne({ ...ownerFilter(owner), code: parsed.data.parentCode }).lean();
    if (!parent || parent.level !== "total")
      throw new AppError("حساب جدید فقط زیر یک حساب کل ساخته می‌شود", 400);
    // the next free code under the total: 1101, 1102, ...
    const siblings = await BizAccount.find({ ...ownerFilter(owner), parentCode: parent.code }).select("code").lean();
    const used = new Set(siblings.map((s) => s.code));
    let n = 1;
    while (used.has(`${parent.code}${String(n).padStart(2, "0")}`)) n++;
    if (n > 99) throw new AppError("زیر این حساب کل جای حساب تازه نیست", 400);
    const account = await BizAccount.create({
      ...(owner.kind === "platform" ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: owner.id }),
      code: `${parent.code}${String(n).padStart(2, "0")}`,
      name: parsed.data.name,
      type: parent.type,
      level: "detail",
      parentCode: parent.code,
    });
    res.status(201).json({ message: "bizCreateAccount", data: account });
  }),

  renameAccount: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(200) }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.accountId))
      throw new AppError("نام حساب را بنویسید", 400);
    const account = await BizAccount.findOneAndUpdate(
      { ...ownerFilter(owner), _id: req.params.accountId },
      { $set: { name: parsed.data.name } },
      { new: true },
    );
    if (!account) throw new NotFoundError();
    res.status(200).json({ message: "bizRenameAccount", data: account });
  }),

  deleteAccount: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.accountId)) throw new NotFoundError();
    const account = await BizAccount.findOne({ ...ownerFilter(owner), _id: req.params.accountId }).lean();
    if (!account) throw new NotFoundError();
    if (account.role) throw new AppError("حساب‌های سیستمی حذف نمی‌شوند؛ می‌توانید نامشان را عوض کنید", 400);
    if (await BizVoucher.exists({ ...ownerFilter(owner), "lines.account": account._id }))
      throw new AppError("این حساب در سند استفاده شده و حذف نمی‌شود", 400);
    await BizAccount.deleteOne({ _id: account._id });
    res.status(200).json({ message: "bizDeleteAccount" });
  }),

  getVouchers: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema
      .extend({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        kind: z.enum(["auto", "manual"]).optional(),
        q: z.string().max(100).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const { page, limit, kind, q, from, to } = parsed.data;
    const filter: Record<string, unknown> = { ...ownerFilter(owner) };
    if (from || to) filter.date = { ...(from ? { $gte: startOf(from) } : {}), ...(to ? { $lte: endOf(to) } : {}) };
    if (kind) filter.kind = kind;
    if (q) {
      const n = Number(q.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      filter.$or = [
        { description: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
        ...(Number.isFinite(n) ? [{ number: n }] : []),
      ];
    }
    const [items, total] = await Promise.all([
      BizVoucher.find(filter).sort({ date: -1, number: -1 }).skip((page - 1) * limit).limit(limit).lean<IBizVoucher[]>(),
      BizVoucher.countDocuments(filter),
    ]);
    res.status(200).json({ message: "bizVouchers", data: { items: items.map(localizeDescription), total, page, limit } });
  }),

  getVoucher: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.voucherId)) throw new NotFoundError();
    const voucher = await BizVoucher.findOne({ ...ownerFilter(owner), _id: req.params.voucherId }).lean<IBizVoucher>();
    if (!voucher) throw new NotFoundError();
    const accounts = await BizAccount.find({ _id: { $in: voucher.lines.map((l) => l.account) } })
      .select("code name role type")
      .lean();
    const byId = new Map(accounts.map((a) => [String(a._id), localizeAccount(a)]));
    res.status(200).json({
      message: "bizVoucher",
      data: { ...localizeDescription(voucher), lines: voucher.lines.map((l) => ({ ...l, account: byId.get(String(l.account)) || null })) },
    });
  }),

  // a voucher typed by hand: any balanced set of detail-account lines
  createVoucher: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = voucherBody
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("شرح سند و دست‌کم دو ردیف را وارد کنید", 400);
    if (parsed.data.lines.some((l) => !isValidObjectId(l.account)))
      throw new AppError("حساب ردیف سند پیدا نشد", 400);
    const voucher = await postVoucher(owner, {
      kind: "manual",
      date: startOf(parsed.data.date) || new Date(),
      description: parsed.data.description,
      lines: parsed.data.lines.map((l) => ({ accountId: l.account, label: l.label, debit: l.debit, credit: l.credit })),
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "bizCreateVoucher", data: voucher });
  }),

  // a hand-typed voucher is corrected in place (same number); an automatic
  // one is never edited
  updateVoucher: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.voucherId)) throw new NotFoundError();
    const parsed = voucherBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("شرح سند و دست‌کم دو ردیف را وارد کنید", 400);
    if (parsed.data.lines.some((l) => !isValidObjectId(l.account)))
      throw new AppError("حساب ردیف سند پیدا نشد", 400);
    const voucher = await BizVoucher.findOne({ ...ownerFilter(owner), _id: req.params.voucherId });
    if (!voucher) throw new NotFoundError();
    if (voucher.kind !== "manual")
      throw new AppError("سندهای خودکار از رویدادهای واقعی ساخته شده‌اند و ویرایش نمی‌شوند", 400);
    const { lines, total } = await buildLines(
      owner,
      parsed.data.lines.map((l) => ({ accountId: l.account, label: l.label, debit: l.debit, credit: l.credit })),
    );
    voucher.set({
      date: startOf(parsed.data.date) || voucher.date,
      description: parsed.data.description,
      lines,
      total,
    });
    await voucher.save();
    res.status(200).json({ message: "bizUpdateVoucher", data: voucher });
  }),

  // the everyday entry: an expense paid, an income received, a transfer
  quickEntry: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        kind: z.enum(["expense", "income", "transfer"]),
        account: z.string(),
        via: z.string(),
        amount: z.coerce.number().positive().max(1e13),
        date: day,
        description: z.string().trim().min(2).max(500),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("مبلغ، حساب و شرح را وارد کنید", 400);
    const { kind, account, via, amount, date, description } = parsed.data;
    if (!isValidObjectId(account) || !isValidObjectId(via)) throw new AppError("حساب ردیف سند پیدا نشد", 400);
    const [acc, viaAcc] = await Promise.all([
      BizAccount.findOne({ ...ownerFilter(owner), _id: account }).lean(),
      BizAccount.findOne({ ...ownerFilter(owner), _id: via }).lean(),
    ]);
    if (!acc || !viaAcc) throw new AppError("حساب ردیف سند پیدا نشد", 400);
    if (viaAcc.type !== "asset") throw new AppError("پرداخت یا دریافت فقط از صندوق، بانک یا کیف پول ممکن است", 400);
    if (kind === "expense" && acc.type !== "expense") throw new AppError("برای هزینه یک حساب هزینه انتخاب کنید", 400);
    if (kind === "income" && acc.type !== "income") throw new AppError("برای درآمد یک حساب درآمد انتخاب کنید", 400);
    if (kind === "transfer" && acc.type !== "asset")
      throw new AppError("در انتقال، مقصد هم باید صندوق، بانک یا کیف پول باشد", 400);
    if (String(acc._id) === String(viaAcc._id)) throw new AppError("دو طرف سند نمی‌توانند یک حساب باشند", 400);
    const debitAcc = kind === "income" ? viaAcc : acc;
    const creditAcc = kind === "income" ? acc : viaAcc;
    const voucher = await postVoucher(owner, {
      kind: "manual",
      date: startOf(date) || new Date(),
      description,
      lines: [
        { accountId: debitAcc._id, debit: amount, label: description },
        { accountId: creditAcc._id, credit: amount, label: description },
      ],
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "bizQuickEntry", data: voucher });
  }),

  // only a hand-typed voucher can go; an automatic one mirrors a real
  // money movement and stays
  deleteVoucher: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.voucherId)) throw new NotFoundError();
    const voucher = await BizVoucher.findOne({ ...ownerFilter(owner), _id: req.params.voucherId }).lean();
    if (!voucher) throw new NotFoundError();
    if (voucher.kind !== "manual")
      throw new AppError("سندهای خودکار از رویدادهای واقعی ساخته شده‌اند و حذف نمی‌شوند", 400);
    await BizVoucher.deleteOne({ _id: voucher._id });
    res.status(200).json({ message: "bizDeleteVoucher" });
  }),

  getLedger: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema
      .extend({
        account: z.string(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query);
    if (!parsed.success || !isValidObjectId(parsed.data.account)) throw new BadInputError();
    const data = await ledger(
      owner,
      parsed.data.account,
      startOf(parsed.data.from),
      endOf(parsed.data.to),
      parsed.data.page,
      parsed.data.limit,
    );
    if (!data) throw new NotFoundError();
    res.status(200).json({
      message: "bizLedger",
      data: { ...data, items: data.items.map(localizeDescription), account: localizeAccount(data.account) },
    });
  }),

  getTrialBalance: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const data = await trialBalance(owner, startOf(parsed.data.from), endOf(parsed.data.to));
    res.status(200).json({ message: "bizTrialBalance", data: { ...data, rows: data.rows.map(localizeAccount) } });
  }),

  getIncomeStatement: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const data = await incomeStatement(owner, startOf(parsed.data.from), endOf(parsed.data.to));
    res.status(200).json({
      message: "bizIncomeStatement",
      data: { ...data, income: data.income.map(localizeAccount), expenses: data.expenses.map(localizeAccount) },
    });
  }),

  getBalanceSheet: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const data = await balanceSheet(owner, endOf(parsed.data.to));
    res.status(200).json({
      message: "bizBalanceSheet",
      data: {
        ...data,
        assets: data.assets.map(localizeAccount),
        liabilities: data.liabilities.map(localizeAccount),
        equity: data.equity.map(localizeAccount),
      },
    });
  }),
});

export const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
