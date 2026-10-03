import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import MoadianProfile, { IMoadianProfile, moadianEnvs, moadianItemKinds, moadianTaxpayerTypes } from "../Models/MoadianProfile";
import MoadianInvoice, { IMoadianInvoice, moadianInvoiceStatuses, moadianSources } from "../Models/MoadianInvoice";
import { BizOwner, displayName, ensureChart, ownerFilter } from "../Lib/business/coa";
import BizAccount from "../Models/BizAccount";
import { bareKey, makeCsr, newKeyPair, seal } from "../Lib/moadian/jose";
import { fiscalInfo, moadianSimulated } from "../Lib/moadian/client";
import { MEMORY_ID } from "../Lib/moadian/taxid";
import { latinDigits, validLegalId, validNationalCode, validTaxpayerCode } from "../Lib/moadian/ids";
import {
  cancelInvoice,
  clearMoadianCache,
  invoicePacket,
  readyProblems,
  retryAllRejected,
  retryInvoice,
  setBuyer,
} from "../Lib/moadian/issue";
import { orgInfo } from "../Lib/business/campaign";
import { OwnerOf } from "./businessController";
import { candidates, expenseInvoice, ignoreInvoice, importInvoices, linkInvoice, listInvoices, unlinkInvoice } from "../Lib/business/purchaseInvoices";
import { purchaseInvoiceMatches } from "../Models/BizPurchaseInvoice";
import { isValidObjectId } from "mongoose";
import { translateMessage } from "../Lib/i18n/translateMessage";
import { currentLocale } from "../Lib/i18n/requestContext";

// Noyan Business Moadian API (2026-10, under /<panel>/moadian and
// /admin/finance/moadian for Noyan's own): the link settings and key, and the
// invoices the engine made (Lib/moadian/issue.ts). Reading needs
// readMoadian, everything else manageMoadian; the plan module "moadian"
// opens it (Routers/moadianRoutes.ts).

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const digits = z.preprocess(latinDigits, z.string());
const optDigits = z.preprocess((v) => (v == null ? v : latinDigits(v)), z.string().optional());

const settingsBody = z.object({
  taxpayerType: z.enum(moadianTaxpayerTypes).optional(),
  name: z.string().trim().max(200).optional(),
  economicCode: optDigits,
  postalCode: optDigits.refine((v) => !v || /^\d{10}$/.test(v), { message: "کد پستی باید ۱۰ رقم باشد" }),
  memoryId: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => !v || MEMORY_ID.test(v), { message: "شناسه‌ی یکتای حافظه‌ی مالیاتی ۶ حرف و رقم لاتین است" })
    .optional(),
  env: z.enum(moadianEnvs).optional(),
  unit: z.string().trim().regex(/^\d{1,8}$/).optional(),
  vatPercent: z.number().min(0).max(100).optional(),
  certificate: z.string().max(20000).optional(),
  sstid: z
    .record(z.string(), z.preprocess(latinDigits, z.string().refine((v) => !v || /^\d{13}$/.test(v), { message: "شناسه‌ی کالا یا خدمت ۱۳ رقم است" })))
    .optional(),
});

const buyerBody = z
  .object({
    type: z.enum(["natural", "legal"]),
    nationalId: optDigits,
    economicCode: optDigits,
    name: z.string().trim().max(200).optional(),
    postalCode: optDigits.refine((v) => !v || /^\d{10}$/.test(v), { message: "کد پستی باید ۱۰ رقم باشد" }),
  })
  .superRefine((b, ctx) => {
    if (b.type === "natural" && !validNationalCode(b.nationalId || "")) ctx.addIssue({ code: "custom", message: "کد ملی خریدار درست نیست" });
    if (b.type === "legal" && !(b.nationalId && validLegalId(b.nationalId)) && !/^\d{14}$/.test(b.economicCode || ""))
      ctx.addIssue({ code: "custom", message: "شناسه‌ی ملی یا کد اقتصادی خریدار درست نیست" });
  });

const listQuery = z.object({
  status: z.enum(moadianInvoiceStatuses).optional(),
  source: z.enum(moadianSources).optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

// the engine's own problems are Persian; the tax organisation's are too
const localized = <T extends { taxErrors?: { code?: string; message: string }[]; taxWarnings?: { code?: string; message: string }[] }>(inv: T): T => {
  const loc = currentLocale();
  const tr = (l?: { code?: string; message: string }[]) => (l || []).map((e) => ({ ...e, message: translateMessage(e.message, loc) }));
  return { ...inv, taxErrors: tr(inv.taxErrors), taxWarnings: tr(inv.taxWarnings) };
};

const firstIssue = (e: z.ZodError) => e.issues.find((i) => i.code === "custom")?.message;

// a doctor is a person; a centre (and Noyan) a company, until told otherwise
const defaultType = (owner: BizOwner) => (owner.kind === "doctor" ? "natural" : "legal");

const publicProfile = (p: (IMoadianProfile & { privateKey?: string }) | null, owner: BizOwner) => ({
  isActive: !!p?.isActive,
  activeFrom: p?.activeFrom,
  env: p?.env || "production",
  taxpayerType: p?.taxpayerType || defaultType(owner),
  name: p?.name || "",
  economicCode: p?.economicCode || "",
  postalCode: p?.postalCode || "",
  memoryId: p?.memoryId || "",
  hasKey: !!p?.publicKey,
  publicKey: p?.publicKey ? bareKey(p.publicKey) : "",
  csr: p?.csr || "",
  certificate: p?.certificate || "",
  keyCreatedAt: p?.keyCreatedAt,
  sstid: p?.sstid || {},
  unit: p?.unit || "1627",
  vatPercent: p?.vatPercent ?? 10,
  lastError: p?.lastError ? translateMessage(p.lastError, currentLocale()) : undefined,
  lastErrorAt: p?.lastErrorAt,
  lastSentAt: p?.lastSentAt,
  problems: readyProblems({ memoryId: p?.memoryId, economicCode: p?.economicCode, publicKey: p?.publicKey }).map((m) =>
    translateMessage(m, currentLocale()),
  ),
  itemKinds: moadianItemKinds.filter((k) =>
    owner.kind === "platform" ? ["commission", "subscription", "sms"].includes(k) : !["commission", "subscription", "sms"].includes(k),
  ),
  simulated: moadianSimulated(),
});

const counts = async (owner: BizOwner) => {
  const rows = await MoadianInvoice.aggregate<{ _id: string; n: number; sum: number }>([
    { $match: ownerFilter(owner) },
    { $group: { _id: "$status", n: { $sum: 1 }, sum: { $sum: "$total.tbill" } } },
  ]);
  return Object.fromEntries(moadianInvoiceStatuses.map((s) => [s, rows.find((r) => r._id === s)?.n || 0]));
};

// Noyan itself buys nothing through the books' purchases
const noPlatform = (owner: BizOwner) => {
  if (owner.kind === "platform") throw new NotFoundError();
};

export const makeMoadianController = (ownerOf: OwnerOf) => ({
  getSettings: withOwner(ownerOf, async (owner, _req, res) => {
    const p = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    res.status(200).json({ message: "moadianSettings", data: { ...publicProfile(p, owner), counts: await counts(owner) } });
  }),

  saveSettings: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) throw firstIssue(parsed.error) ? new AppError(firstIssue(parsed.error)!, 400) : new BadInputError();
    const d = parsed.data;
    const current = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    const type = d.taxpayerType || current?.taxpayerType || defaultType(owner);
    if (d.economicCode && !validTaxpayerCode(type, d.economicCode))
      throw new AppError(type === "natural" ? "کد ملی درست نیست" : "شناسه‌ی ملی یا کد اقتصادی درست نیست", 400);
    const $set: Record<string, unknown> = {};
    for (const k of ["taxpayerType", "name", "economicCode", "postalCode", "memoryId", "env", "unit", "certificate"] as const)
      if (d[k] !== undefined) $set[k] = d[k];
    if (!current && !$set.taxpayerType) $set.taxpayerType = type;
    if (owner.kind === "platform" && d.vatPercent !== undefined) $set.vatPercent = d.vatPercent;
    if (d.sstid) for (const k of moadianItemKinds) if (d.sstid[k] !== undefined) $set[`sstid.${k}`] = d.sstid[k];
    if (current?.isActive && (($set.memoryId && $set.memoryId !== current.memoryId) || ($set.economicCode === "" || $set.memoryId === "")))
      throw new AppError("برای تغییر شناسه‌ی حافظه، اول ارسال را خاموش کنید", 400);
    await MoadianProfile.updateOne(ownerFilter(owner), { $set }, { upsert: true });
    clearMoadianCache();
    const p = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    res.status(200).json({ message: "moadianSettingsSaved", data: publicProfile(p, owner) });
  }),

  // a fresh key pair and its certificate request; the old key stops working
  makeKey: withOwner(ownerOf, async (owner, req, res) => {
    const current = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    if (current?.isActive) throw new AppError("برای ساختن کلید تازه، اول ارسال را خاموش کنید", 400);
    if (current?.publicKey && req.body?.replace !== true) throw new AppError("کلید قبلاً ساخته شده است", 400);
    const name = current?.name || (owner.kind === "platform" ? "Noyan" : (await orgInfo(owner).catch(() => ({ name: "" }))).name) || "Taxpayer";
    const keys = newKeyPair();
    const csr = makeCsr(keys.privateKey, keys.publicKey, { name, nationalId: current?.economicCode || "" });
    await MoadianProfile.updateOne(
      ownerFilter(owner),
      {
        $set: {
          privateKey: seal(keys.privateKey),
          publicKey: keys.publicKey,
          csr,
          keyCreatedAt: new Date(),
          ...(current ? {} : { taxpayerType: defaultType(owner) }),
        },
        $unset: { certificate: 1 },
      },
      { upsert: true },
    );
    clearMoadianCache();
    const p = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    res.status(200).json({ message: "moadianKeyMade", data: publicProfile(p, owner) });
  }),

  // checks the key and the memory id against the tax organisation first
  setActive: withOwner(ownerOf, async (owner, req, res) => {
    const on = req.body?.on === true;
    const p = await MoadianProfile.findOne(ownerFilter(owner)).select("+privateKey").lean<IMoadianProfile & { privateKey?: string }>();
    if (on) {
      if (!p) throw new AppError("ابتدا کلید را بسازید", 400);
      const problems = readyProblems(p);
      if (problems.length || !p.privateKey) throw new AppError(problems[0] || "ابتدا کلید را بسازید", 400);
      await fiscalInfo({ env: p.env, memoryId: String(p.memoryId), privateKey: p.privateKey, certificate: p.certificate });
    }
    await MoadianProfile.updateOne(ownerFilter(owner), on ? { $set: { isActive: true, activeFrom: new Date() } } : { $set: { isActive: false } });
    clearMoadianCache();
    const fresh = await MoadianProfile.findOne(ownerFilter(owner)).lean<IMoadianProfile>();
    res.status(200).json({ message: "moadianActive", data: publicProfile(fresh, owner) });
  }),

  getInvoices: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const { status, source, q, page } = parsed.data;
    const filter: Record<string, unknown> = { ...ownerFilter(owner) };
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [{ taxId: new RegExp(safe.toUpperCase()) }, { party: new RegExp(safe) }];
    }
    const per = 30;
    const [rows, total] = await Promise.all([
      MoadianInvoice.find(filter)
        .sort({ issuedAt: -1, serial: -1 })
        .skip((page - 1) * per)
        .limit(per)
        .select("source subject type taxId issuedAt party total status taxErrors replacedBy of")
        .lean<IMoadianInvoice[]>(),
      MoadianInvoice.countDocuments(filter),
    ]);
    res.status(200).json({ message: "moadianInvoices", data: { rows: rows.map(localized), total, per, counts: await counts(owner) } });
  }),

  getInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const inv = await MoadianInvoice.findOne({ _id: req.params.invoiceId, ...ownerFilter(owner) })
      .populate({ path: "of", select: "taxId subject status" })
      .populate({ path: "replacedBy", select: "taxId subject status" })
      .lean<IMoadianInvoice>()
      .catch(() => null);
    if (!inv) throw new NotFoundError();
    res.status(200).json({ message: "moadianInvoice", data: { ...localized(inv), packet: await invoicePacket(owner, String(inv._id)) } });
  }),

  retry: withOwner(ownerOf, async (owner, req, res) => {
    await retryInvoice(owner, String(req.params.invoiceId));
    res.status(200).json({ message: "moadianRetry" });
  }),

  retryRejected: withOwner(ownerOf, async (owner, _req, res) => {
    res.status(200).json({ message: "moadianRetryAll", data: { count: await retryAllRejected(owner) } });
  }),

  buyer: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = buyerBody.safeParse(req.body);
    if (!parsed.success) throw firstIssue(parsed.error) ? new AppError(firstIssue(parsed.error)!, 400) : new BadInputError();
    const b = parsed.data;
    await setBuyer(owner, String(req.params.invoiceId), {
      type: b.type,
      nationalId: b.nationalId || undefined,
      economicCode: b.economicCode || (b.type === "natural" ? b.nationalId : undefined) || undefined,
      name: b.name || undefined,
      postalCode: b.postalCode || undefined,
    });
    res.status(200).json({ message: "moadianBuyer" });
  }),

  cancel: withOwner(ownerOf, async (owner, req, res) => {
    await cancelInvoice(owner, String(req.params.invoiceId));
    res.status(200).json({ message: "moadianCancel" });
  }),

  // purchase invoices other sellers registered for this owner, brought in
  // from the کارپوشه's export (Lib/business/purchaseInvoices.ts)
  getPurchaseInvoices: withOwner(ownerOf, async (owner, req, res) => {
    noPlatform(owner);
    const q = z
      .object({
        match: z.enum(purchaseInvoiceMatches).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query);
    if (!q.success) throw new BadInputError();
    res.status(200).json({ message: "moaPurchaseInvoices", data: await listInvoices(owner, { ...q.data, from: null, to: null }) });
  }),

  importPurchaseInvoices: withOwner(ownerOf, async (owner, req, res) => {
    noPlatform(owner);
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file?.buffer?.length) throw new AppError("فایل خروجی صورتحساب‌های خرید را انتخاب کنید", 400);
    res.status(200).json({ message: "moaPurchaseImported", data: await importInvoices(owner, file.buffer, file.originalname || "", req.user?._id) });
  }),

  // the expense accounts an invoice with no purchase can be booked to
  getExpenseAccounts: withOwner(ownerOf, async (owner, _req, res) => {
    noPlatform(owner);
    await ensureChart(owner);
    const rows = await BizAccount.find({ ...ownerFilter(owner), type: "expense", level: "detail", isActive: { $ne: false } })
      .sort({ code: 1 })
      .select("code name role")
      .lean();
    const loc = currentLocale();
    res.status(200).json({ message: "moaExpenseAccounts", data: rows.map((a) => ({ ...a, name: displayName(a, loc) })) });
  }),

  getPurchaseCandidates: withOwner(ownerOf, async (owner, req, res) => {
    noPlatform(owner);
    if (!isValidObjectId(req.params.id)) throw new NotFoundError();
    res.status(200).json({ message: "moaPurchaseCandidates", data: await candidates(owner, req.params.id) });
  }),

  matchPurchaseInvoice: withOwner(ownerOf, async (owner, req, res) => {
    noPlatform(owner);
    if (!isValidObjectId(req.params.id)) throw new NotFoundError();
    const body = z
      .discriminatedUnion("as", [
        z.object({ as: z.literal("purchase"), purchase: z.string() }),
        z.object({ as: z.literal("expense"), account: z.string() }),
        z.object({ as: z.literal("ignored") }),
        z.object({ as: z.literal("open") }),
      ])
      .safeParse(req.body || {});
    if (!body.success) throw new BadInputError();
    const b = body.data;
    if (b.as === "purchase") {
      if (!isValidObjectId(b.purchase)) throw new BadInputError();
      await linkInvoice(owner, req.params.id, b.purchase);
    } else if (b.as === "expense") {
      if (!isValidObjectId(b.account)) throw new BadInputError();
      await expenseInvoice(owner, req.params.id, b.account, req.user?._id);
    } else if (b.as === "ignored") await ignoreInvoice(owner, req.params.id);
    else await unlinkInvoice(owner, req.params.id);
    res.status(200).json({ message: "moaPurchaseMatched" });
  }),
});
