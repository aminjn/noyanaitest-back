import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizAccount, { bizAccountTypes, IBizAccount } from "../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../Models/BizVoucher";
import { bizPartyKinds } from "../Models/BizParty";
import { BizOwner, ensureChart, ownerFilter } from "../Lib/business/coa";
import { currentLocale } from "../Lib/i18n/requestContext";
import { voucherDescriptions } from "../Lib/business/voucherDescriptions";
import { SOURCE_LOCALE } from "../Lib/locales";
import { OwnerOf } from "./businessController";
import * as J from "../Lib/business/journal";
import * as P from "../Lib/business/parties";
import * as L from "../Lib/business/ledgers";
import * as C from "../Lib/business/costing";
import * as A from "../Lib/business/assets";
import * as T from "../Lib/business/treasury";
import * as R from "../Lib/business/requests";
import * as X from "../Lib/business/accExtras";
import { sheetRows } from "../Lib/business/purchaseInvoices";
import { listCenters } from "../Lib/business/analysis";
import { createsCycle } from "../Lib/business/accCore";

// The accounting API of the Nexxa parity work (2026-10), mounted under
// /<panel>/biz/acc by Routers/businessRoutes.ts: reading needs readFinance,
// writing manageAccounting (drafts, documents, the register), and the
// approver's action approveVouchers finalizes, reverts and deletes final
// vouchers and decides requests. The platform's own books use the same
// routes from the super admin (Finance read / update).

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const isId = (v: unknown) => !!v && mongoose.isValidObjectId(String(v));
const id = (v: unknown) => {
  if (!isId(v)) throw new NotFoundError();
  return String(v);
};
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(String(v).replace(/[^\d.-]/g, "")) || 0);
const dayRx = /^\d{4}-\d{2}-\d{2}$/;
const startOf = (s?: unknown) => (typeof s === "string" && dayRx.test(s) ? new Date(`${s}T00:00:00`) : null);
const endOf = (s?: unknown) => (typeof s === "string" && dayRx.test(s) ? new Date(`${s}T23:59:59.999`) : null);
// a document's own date: today keeps the time it is written
const docDate = (s?: unknown) => {
  if (typeof s !== "string" || !dayRx.test(s)) return new Date();
  const d = new Date(`${s}T12:00:00`);
  return d.toDateString() === new Date().toDateString() ? new Date() : d;
};
const page = (q: Record<string, unknown>, def = 30, max = 200) => ({
  page: Math.max(1, Math.floor(Number(q.page) || 1)),
  limit: Math.min(max, Math.max(1, Math.floor(Number(q.limit) || def))),
});
const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const ok = (res: Response, message: string, data?: unknown, status = 200) => res.status(status).json({ message, data });

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const localize = <T extends { description?: string; kind?: string }>(v: T): T => {
  const locale = currentLocale();
  if (v.kind === "manual" || locale === SOURCE_LOCALE || !v.description) return v;
  return { ...v, description: voucherDescriptions[v.description]?.[locale] || v.description };
};

const manualInput = (b: Record<string, unknown>, state: "draft" | "final"): J.ManualInput => ({
  date: docDate(b.date),
  description: str(b.description) || "",
  reference: str(b.reference, 80),
  center: isId(b.center) ? String(b.center) : null,
  state,
  attachments: Array.isArray(b.attachments) ? (b.attachments as unknown[]).filter((a): a is string => typeof a === "string") : undefined,
  lines: Array.isArray(b.lines)
    ? (b.lines as Record<string, unknown>[]).slice(0, 100).map((l) => ({
        account: String(l?.account || ""),
        party: isId(l?.party) ? String(l.party) : null,
        center: isId(l?.center) ? String(l.center) : null,
        label: str(l?.label, 300),
        debit: Number(l?.debit) || 0,
        credit: Number(l?.credit) || 0,
      }))
    : [],
});

const ACCOUNT_LEVELS = ["group", "total", "detail"] as const;

export const makeAccountingController = (ownerOf: OwnerOf) => ({
  // ------------------------------------------------------------- journal
  journal: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    const data = await J.listJournal(
      owner,
      {
        q: str(q.q, 100),
        kind: str(q.kind, 20),
        state: q.state === "draft" || q.state === "final" ? q.state : undefined,
        from: startOf(q.from),
        to: endOf(q.to),
        account: str(q.account, 30),
        party: str(q.party, 30),
        center: str(q.center, 30),
        ...page(q, 20, q.export ? 2000 : 100),
      },
      currentLocale(),
    );
    ok(res, "accJournal", { ...data, items: data.items.map(localize) });
  }),
  voucher: withOwner(ownerOf, async (owner, req, res) => {
    const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id(req.params.voucherId) }).setOptions({ withDrafts: true }).lean<IBizVoucher>();
    if (!v) throw new NotFoundError();
    const [full] = await J.withNames(owner, [v], currentLocale());
    ok(res, "accVoucher", { ...localize(full), history: await J.voucherHistory(owner, String(v._id)) });
  }),
  createVoucher: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accCreateVoucher", await J.createManualVoucher(owner, manualInput(body(req), "draft"), req.user?._id), 201);
  }),
  // a draft is rewritten by a writer; a final voucher goes back to draft first
  updateVoucher: withOwner(ownerOf, async (owner, req, res) => {
    const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id(req.params.voucherId) }).setOptions({ withDrafts: true }).lean<IBizVoucher>();
    if (!v) throw new NotFoundError();
    if (v.state !== "draft") throw new AppError("سند قطعی ویرایش نمی‌شود؛ ابتدا آن را به پیش‌نویس برگردانید", 400);
    ok(res, "accUpdateVoucher", await J.updateManualVoucher(owner, String(v._id), manualInput(body(req), "draft"), req.user?._id));
  }),
  deleteDraft: withOwner(ownerOf, async (owner, req, res) => {
    const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id(req.params.voucherId) }).setOptions({ withDrafts: true }).lean<IBizVoucher>();
    if (!v) throw new NotFoundError();
    if (v.state !== "draft") throw new AppError("حذف سند قطعی فقط با دسترسی تأیید اسناد ممکن است", 403);
    await J.deleteManualVoucher(owner, String(v._id), req.user?._id);
    ok(res, "accDeleteVoucher");
  }),
  finalize: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accFinalizeVoucher", await J.finalizeVoucher(owner, id(req.params.voucherId), req.user?._id));
  }),
  revert: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accRevertVoucher", await J.revertVoucher(owner, id(req.params.voucherId), req.user?._id));
  }),
  deleteVoucher: withOwner(ownerOf, async (owner, req, res) => {
    await J.deleteManualVoucher(owner, id(req.params.voucherId), req.user?._id);
    ok(res, "accDeleteVoucher");
  }),
  attachments: withOwner(ownerOf, async (owner, req, res) => {
    const list = body(req).attachments;
    if (!Array.isArray(list)) throw new BadInputError();
    ok(res, "accAttachments", await J.setAttachments(owner, id(req.params.voucherId), list as string[], req.user?._id));
  }),
  audit: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accAudit", await J.auditLog(owner, { from: startOf(q.from), to: endOf(q.to), action: str(q.action, 20), ...page(q, 30) }));
  }),

  // ------------------------------------------------- opening and coding
  opening: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    const rows = Array.isArray(b.rows) ? (b.rows as J.OpeningRow[]).slice(0, 2000) : [];
    ok(res, "accOpening", await J.importOpeningBalances(owner, rows, docDate(b.date), req.user?._id));
  }),
  // an Excel / CSV file of «code / debit / credit (/ party)» columns
  openingFile: withOwner(ownerOf, async (owner, req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) throw new AppError("فایل را انتخاب کنید", 400);
    const rows = await sheetRows(file.buffer, file.originalname);
    const head = (rows[0] || []).map((c) => String(c ?? "").trim());
    const col = (keys: string[], fallback: number) => {
      const i = head.findIndex((h) => keys.some((k) => h.includes(k)));
      return i >= 0 ? i : fallback;
    };
    const hasHead = head.some((h) => /[^\d\s.,]/.test(h));
    const cCode = col(["کد", "code"], 0);
    const cDebit = col(["بدهکار", "debit"], 1);
    const cCredit = col(["بستانکار", "credit"], 2);
    const cParty = head.findIndex((h) => ["تفصیلی", "طرف", "party"].some((k) => h.includes(k)));
    const data = rows.slice(hasHead ? 1 : 0).map((r) => ({
      code: String(r[cCode] ?? ""),
      debit: Number(String(r[cDebit] ?? "0").replace(/[^\d.]/g, "")) || 0,
      credit: Number(String(r[cCredit] ?? "0").replace(/[^\d.]/g, "")) || 0,
      partyName: cParty >= 0 ? String(r[cParty] ?? "").trim() : undefined,
    }));
    ok(res, "accOpening", await J.importOpeningBalances(owner, data, docDate(body(req).date), req.user?._id));
  }),
  coding: withOwner(ownerOf, async (owner, req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    let text = str(body(req).text, 200_000) || "";
    if (file) text = (await sheetRows(file.buffer, file.originalname)).map((r) => `${r[0] ?? ""} ${r[1] ?? ""}`).join("\n");
    ok(res, "accCoding", await J.importCoding(owner, text));
  }),

  // ------------------------------------------------------------ accounts
  // a group, total or detail account with an explicit or next code
  // (Nexxa createAccountGroup / createTotalAccount / createMoeinAccount)
  createAccount: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    const level = ACCOUNT_LEVELS.find((l) => l === b.level) || "detail";
    const name = (str(b.name, 200) || "").trim();
    if (name.length < 2) throw new AppError("نام حساب را بنویسید", 400);
    await ensureChart(owner);
    let parent: IBizAccount | null = null;
    let type = bizAccountTypes.find((t) => t === b.type);
    if (level !== "group") {
      parent = await BizAccount.findOne({ ...ownerFilter(owner), code: str(b.parentCode, 20) }).lean<IBizAccount>();
      if (!parent || parent.level !== (level === "total" ? "group" : "total"))
        throw new AppError(level === "total" ? "حساب کل فقط زیر یک گروه ساخته می‌شود" : "حساب جدید فقط زیر یک حساب کل ساخته می‌شود", 400);
      type = parent.type;
    }
    if (!type) throw new AppError("نوع حساب را انتخاب کنید", 400);
    let code = String(b.code || "").replace(/\D/g, "");
    const prefix = parent?.code || "";
    if (code) {
      if (!code.startsWith(prefix) || code.length <= prefix.length) throw new AppError("کد حساب باید با کد حساب بالادست شروع شود", 400);
      if (await BizAccount.exists({ ...ownerFilter(owner), code })) throw new AppError("این کد حساب تکراری است", 400);
    } else {
      const width = level === "group" ? 1 : level === "total" ? 1 : 2;
      const used = new Set((await BizAccount.find({ ...ownerFilter(owner), ...(parent ? { parentCode: parent.code } : { level: "group" }) }).select("code").lean()).map((a) => a.code));
      let n = 1;
      while (used.has(`${prefix}${String(n).padStart(width, "0")}`)) n++;
      if (String(n).length > width) throw new AppError("زیر این حساب کل جای حساب تازه نیست", 400);
      code = `${prefix}${String(n).padStart(width, "0")}`;
    }
    const kinds = Array.isArray(b.tafsiliKinds) ? (b.tafsiliKinds as string[]).filter((k) => (bizPartyKinds as readonly string[]).includes(k)) : undefined;
    const account = await BizAccount.create({
      ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) }),
      code,
      name,
      type,
      level,
      parentCode: parent?.code,
      description: str(b.description, 300),
      nature: ["debit", "credit", "both"].includes(String(b.nature)) ? b.nature : undefined,
      permanent: typeof b.permanent === "boolean" ? b.permanent : ["asset", "liability", "equity"].includes(type),
      ...(level === "detail" && kinds?.length ? { tafsiliKinds: kinds } : {}),
    });
    ok(res, "accCreateAccount", account, 201);
  }),
  // name, description, nature, permanence, the party kinds it takes, active
  // (a system account: name and party kinds only; never deactivated)
  updateAccount: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: id(req.params.accountId) });
    if (!acc) throw new NotFoundError();
    if (b.name !== undefined) {
      const name = (str(b.name, 200) || "").trim();
      if (name.length < 2) throw new AppError("نام حساب را بنویسید", 400);
      acc.name = name;
    }
    if (b.description !== undefined) acc.description = str(b.description, 300) || undefined;
    if (Array.isArray(b.tafsiliKinds) && acc.level === "detail")
      acc.tafsiliKinds = (b.tafsiliKinds as string[]).filter((k) => (bizPartyKinds as readonly string[]).includes(k));
    if (!acc.role) {
      if (["debit", "credit", "both"].includes(String(b.nature))) acc.nature = b.nature as IBizAccount["nature"];
      if (typeof b.permanent === "boolean") acc.permanent = b.permanent;
      if (typeof b.isActive === "boolean") acc.isActive = b.isActive;
      // a detail account moved under another total of the same type
      if (typeof b.parentCode === "string" && acc.level === "detail" && b.parentCode !== acc.parentCode) {
        const parent = await BizAccount.findOne({ ...ownerFilter(owner), code: b.parentCode, level: "total" }).lean<IBizAccount>();
        if (!parent || parent.type !== acc.type) throw new AppError("حساب جدید فقط زیر یک حساب کل ساخته می‌شود", 400);
        acc.parentCode = parent.code;
      }
    } else if (b.isActive === false) throw new AppError("حساب‌های سیستمی غیرفعال نمی‌شوند", 400);
    await acc.save();
    ok(res, "accUpdateAccount", acc);
  }),
  // a group / total with no children, a detail with no lines (Nexxa
  // deleteAccountNode); system accounts stay
  deleteAccount: withOwner(ownerOf, async (owner, req, res) => {
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: id(req.params.accountId) }).lean<IBizAccount>();
    if (!acc) throw new NotFoundError();
    if (acc.role) throw new AppError("حساب‌های سیستمی حذف نمی‌شوند؛ می‌توانید نامشان را عوض کنید", 400);
    if (await BizAccount.exists({ ...ownerFilter(owner), parentCode: acc.code })) throw new AppError("این حساب زیرمجموعه دارد و حذف نمی‌شود", 400);
    if (await BizVoucher.exists({ ...ownerFilter(owner), "lines.account": acc._id }).setOptions({ withDrafts: true }))
      throw new AppError("این حساب در سند استفاده شده و حذف نمی‌شود", 400);
    await BizAccount.deleteOne({ _id: acc._id });
    ok(res, "accDeleteAccount");
  }),
  autoLink: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accAutoLink", { linked: await P.autoLinkTafsili(owner) });
  }),

  // ------------------------------------------------------------- parties
  parties: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accParties", await P.listParties(owner, { kind: str(q.kind, 20), q: str(q.q, 100), active: q.active === "1", ...page(q, 50, 500) }));
  }),
  partyBalances: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    const status = q.status === "debit" || q.status === "credit" || q.status === "settled" ? q.status : undefined;
    ok(res, "accPartyBalances", await P.partyBalances(owner, { from: startOf(q.from), to: endOf(q.to), kind: str(q.kind, 20), account: str(q.account, 30), q: str(q.q, 100), status }));
  }),
  createParty: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    const party = await P.createParty(owner, b as unknown as P.PartyForm);
    const opening = num(b.opening) || 0;
    if (opening > 0) await J.postPartyOpening(owner, String(party._id), opening, b.openingSide === "credit" ? "credit" : "debit", docDate(b.openingDate), req.user?._id);
    ok(res, "accCreateParty", party, 201);
  }),
  updateParty: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accUpdateParty", await P.updateParty(owner, id(req.params.partyId), body(req) as Partial<P.PartyForm>));
  }),
  deleteParty: withOwner(ownerOf, async (owner, req, res) => {
    await P.deleteParty(owner, id(req.params.partyId));
    ok(res, "accDeleteParty");
  }),
  partyOpening: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accPartyOpening", await J.postPartyOpening(owner, id(req.params.partyId), num(b.amount) || 0, b.side === "credit" ? "credit" : "debit", docDate(b.date), req.user?._id));
  }),

  // ------------------------------------------------------------- books
  ledger: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    const data = await L.ledgerOf(
      owner,
      { account: str(q.account, 30), party: str(q.party, 30), center: str(q.center, 30), from: startOf(q.from), to: endOf(q.to), ...page(q, 50, q.export ? 5000 : 200) },
      currentLocale(),
    );
    if (!data) throw new NotFoundError();
    ok(res, "accLedger", { ...data, items: data.items.map(localize) });
  }),
  totalLedger: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accTotalLedger", await L.totalLedger(owner, startOf(q.from), endOf(q.to), q.level === "group" ? "group" : "total", currentLocale(), str(q.center, 30)));
  }),
  trial: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    const level = (["group", "total", "detail", "party"] as const).find((l) => l === q.level) || "total";
    ok(res, "accTrial", await L.trial(owner, { level, from: startOf(q.from), to: endOf(q.to), center: str(q.center, 30) }, currentLocale()));
  }),
  review: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accReview", await L.reviewTree(owner, startOf(q.from), endOf(q.to), currentLocale()));
  }),

  // ------------------------------------------------ cost centres, allocation
  saveCenter: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveCenter", await C.saveCenter(owner, { id: isId(req.params.centerId) ? String(req.params.centerId) : undefined, name: str(b.name, 80) || "", code: str(b.code, 20), parent: isId(b.parent) ? String(b.parent) : null, description: str(b.description, 300), isActive: typeof b.isActive === "boolean" ? b.isActive : undefined }));
  }),
  deleteCenter: withOwner(ownerOf, async (owner, req, res) => {
    await C.deleteCenter(owner, id(req.params.centerId));
    ok(res, "accDeleteCenter");
  }),
  centersTree: withOwner(ownerOf, async (owner, _req, res) => {
    const list = await listCenters(owner);
    // guard: a parent loop in old data is cut instead of looping the page
    const parents = new Map(list.map((c) => [String(c._id), c.parent ? String(c.parent) : null]));
    ok(res, "accCenters", list.map((c) => ({ ...c, parent: c.parent && !createsCycle(new Map([...parents].filter(([k]) => k !== String(c._id))), String(c._id), String(c.parent)) ? c.parent : null })));
  }),
  allocations: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accAllocations", await C.listAllocations(owner));
  }),
  saveAllocation: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveAllocation", await C.saveAllocation(owner, { id: isId(b.id) ? String(b.id) : undefined, title: str(b.title, 120) || "", source: String(b.source || ""), lines: Array.isArray(b.lines) ? (b.lines as { target: string; percent: number }[]) : [] }));
  }),
  deleteAllocation: withOwner(ownerOf, async (owner, req, res) => {
    await C.deleteAllocation(owner, id(req.params.allocId));
    ok(res, "accDeleteAllocation");
  }),
  runAllocation: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    const now = new Date();
    const from = startOf(b.from) || new Date(now.getFullYear(), now.getMonth(), 1);
    const to = endOf(b.to) || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    ok(res, "accRunAllocation", await C.runAllocation(owner, id(req.params.allocId), from, to, req.user?._id));
  }),

  // ------------------------------------------------------- fixed assets
  assets: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accAssets", await A.listAssets(owner, { state: str(q.state, 20), group: str(q.group, 30), q: str(q.q, 100) }));
  }),
  asset: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accAsset", await A.getAsset(owner, id(req.params.assetId)));
  }),
  createAsset: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(
      res,
      "accCreateAsset",
      await A.createAsset(
        owner,
        {
          name: str(b.name, 200) || "",
          code: str(b.code, 30),
          category: str(b.category, 120),
          group: str(b.group, 30),
          account: str(b.account, 30),
          cost: num(b.cost) || 0,
          salvageValue: num(b.salvageValue),
          usefulLifeYears: num(b.usefulLifeYears),
          method: str(b.method, 20),
          decliningRate: num(b.decliningRate),
          acquisitionDate: docDate(b.acquisitionDate),
          serial: str(b.serial, 80),
          location: str(b.location, 200),
          custodian: str(b.custodian, 200),
          center: str(b.center, 30),
          book: (["money", "payable", "opening", "none"] as const).find((x) => x === b.book) || "none",
          money: str(b.money, 30),
          vendor: str(b.vendor, 200),
          priorDepreciation: num(b.priorDepreciation),
        },
        req.user?._id,
      ),
      201,
    );
  }),
  updateAsset: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accUpdateAsset", await A.updateAsset(owner, id(req.params.assetId), { ...b, salvageValue: num(b.salvageValue), usefulLifeYears: num(b.usefulLifeYears), decliningRate: num(b.decliningRate) } as Partial<A.AssetInput>));
  }),
  deleteAsset: withOwner(ownerOf, async (owner, req, res) => {
    await A.deleteAsset(owner, id(req.params.assetId), req.user?._id);
    ok(res, "accDeleteAsset");
  }),
  depreciate: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accDepreciate", await A.runDepreciation(owner, req.user?._id));
  }),
  dispose: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accDispose", await A.disposeAsset(owner, id(req.params.assetId), { date: docDate(b.date), proceeds: num(b.proceeds), money: str(b.money, 30), note: str(b.note) }, req.user?._id));
  }),
  revalue: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accRevalue", await A.revalueAsset(owner, id(req.params.assetId), { fairValue: num(b.fairValue) ?? -1, date: docDate(b.date), note: str(b.note) }, req.user?._id));
  }),
  transferAsset: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accTransferAsset", await A.transferAsset(owner, id(req.params.assetId), { location: str(b.location, 200), custodian: str(b.custodian, 200), date: docDate(b.date), note: str(b.note) }));
  }),
  maintenance: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(
      res,
      "accMaintenance",
      await A.addMaintenance(
        owner,
        id(req.params.assetId),
        { date: docDate(b.date), kind: str(b.kind, 20), cost: num(b.cost), vendor: str(b.vendor, 200), note: str(b.note), nextDueDate: startOf(b.nextDueDate), book: b.book === true, money: str(b.money, 30) },
        req.user?._id,
      ),
    );
  }),
  assetEvents: withOwner(ownerOf, async (owner, req, res) => {
    const kind = (["transfer", "maintenance", "revaluation"] as const).find((k) => k === req.query.kind) || "transfer";
    ok(res, "accAssetEvents", await A.listEvents(owner, kind));
  }),
  deleteAssetEvent: withOwner(ownerOf, async (owner, req, res) => {
    await A.deleteEvent(owner, id(req.params.eventId), req.user?._id);
    ok(res, "accDeleteAssetEvent");
  }),
  assetReport: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accAssetReport", await A.assetReport(owner));
  }),
  assetGroups: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accAssetGroups", await A.listGroups(owner));
  }),
  saveAssetGroup: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveAssetGroup", await A.saveGroup(owner, { id: isId(b.id) ? String(b.id) : undefined, name: str(b.name, 120) || "", usefulLifeYears: num(b.usefulLifeYears), method: str(b.method, 20), decliningRate: num(b.decliningRate), account: str(b.account, 30) }));
  }),
  deleteAssetGroup: withOwner(ownerOf, async (owner, req, res) => {
    await A.deleteGroup(owner, id(req.params.groupId));
    ok(res, "accDeleteAssetGroup");
  }),
  seedAssetGroups: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accAssetGroups", await A.seedGroups(owner));
  }),

  // ------------------------------------------------------------ treasury
  treasury: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accTreasury", await T.listTreasury(owner));
  }),
  openTreasury: withOwner(ownerOf, async (owner, req, res) => {
    if (owner.kind === "platform") throw new NotFoundError();
    const b = body(req);
    const kind = (["cash", "bank", "pos", "petty"] as const).find((k) => k === b.kind) || "bank";
    ok(
      res,
      "accOpenTreasury",
      await T.openTreasuryAccount(
        owner,
        { kind, name: str(b.name, 120) || "", bankName: str(b.bankName, 80), accountNumber: str(b.accountNumber, 40), sheba: str(b.sheba, 34), holder: str(b.holder, 120), pettyLimit: num(b.pettyLimit), opening: num(b.opening), date: docDate(b.date) },
        req.user?._id,
      ),
      201,
    );
  }),
  updateTreasury: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accUpdateTreasury", await T.updateTreasuryAccount(owner, id(req.params.moneyId), { holder: str(b.holder, 120), pettyLimit: num(b.pettyLimit) }));
  }),
  transfer: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accTransfer", await T.transferFunds(owner, { from: String(b.from || ""), to: String(b.to || ""), amount: num(b.amount) || 0, date: docDate(b.date), description: str(b.description, 200), reference: str(b.reference, 80) }, req.user?._id), 201);
  }),
  transfers: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accTransfers", await T.listTransfers(owner));
  }),
  voidTransfer: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accVoidTransfer", await T.voidTransfer(owner, id(req.params.voucherId), req.user?._id));
  }),
  bankFee: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accBankFee", await T.recordBankFee(owner, { money: String(b.money || ""), amount: num(b.amount) || 0, date: docDate(b.date), description: str(b.description, 200) }, req.user?._id), 201);
  }),
  petty: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accPetty", await T.pettyStatus(owner, id(req.params.moneyId)));
  }),
  chargePetty: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accChargePetty", await T.chargePetty(owner, { petty: id(req.params.moneyId), from: String(b.from || ""), amount: num(b.amount) || 0, date: docDate(b.date), note: str(b.note, 200) }, req.user?._id), 201);
  }),
  bankRec: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accBankRec", await T.bankRec(owner, id(req.params.moneyId)));
  }),
  statementPreview: withOwner(ownerOf, async (owner, req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) throw new AppError("فایل را انتخاب کنید", 400);
    ok(res, "accStatementPreview", await T.previewStatement(file.buffer, file.originalname));
  }),
  statementImport: withOwner(ownerOf, async (owner, req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) throw new AppError("فایل را انتخاب کنید", 400);
    let mapping: T.StatementMapping;
    try {
      mapping = JSON.parse(String(body(req).mapping || "{}"));
    } catch {
      throw new BadInputError();
    }
    if (typeof mapping?.date !== "number") throw new AppError("ستون تاریخ و مبلغ را مشخص کنید", 400);
    ok(res, "accStatementImport", await T.importStatement(owner, id(req.params.moneyId), file.buffer, file.originalname, mapping));
  }),
  autoMatch: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accAutoMatch", await T.autoMatch(owner, id(req.params.moneyId)));
  }),
  matchLine: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accMatchLine", await T.matchLine(owner, id(req.params.lineId), String(body(req).voucher || "")));
  }),
  unmatchLine: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accUnmatchLine", await T.unmatchLine(owner, id(req.params.lineId)));
  }),
  ignoreLine: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accIgnoreLine", await T.ignoreLine(owner, id(req.params.lineId), body(req).ignored !== false));
  }),
  bookLine: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accBookLine", await T.bookLine(owner, id(req.params.lineId), { account: String(b.account || ""), party: str(b.party, 30), description: str(b.description, 300) }, req.user?._id));
  }),
  clearStatement: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accClearStatement", await T.deleteStatementBatch(owner, id(req.params.moneyId), str(req.query.batch, 20)));
  }),
  depositCheque: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accDepositCheque", await T.depositCheque(owner, id(req.params.paymentId), { money: str(b.money, 30), date: docDate(b.date), note: str(b.note, 300) }));
  }),
  endorseCheque: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accEndorseCheque", await T.endorseCheque(owner, id(req.params.paymentId), { party: str(b.party, 30), partyName: str(b.partyName, 200), date: docDate(b.date), note: str(b.note, 300) }, req.user?._id));
  }),
  revertCheque: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accRevertCheque", await T.revertCheque(owner, id(req.params.paymentId), req.user?._id));
  }),
  checkbooks: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accCheckbooks", await T.listCheckbooks(owner));
  }),
  saveCheckbook: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveCheckbook", await T.saveCheckbook(owner, { id: isId(b.id) ? String(b.id) : undefined, money: str(b.money, 30), serial: str(b.serial, 40) || "", fromNo: str(b.fromNo, 30) || "", toNo: str(b.toNo, 30) || "", count: num(b.count), description: str(b.description, 300), isActive: typeof b.isActive === "boolean" ? b.isActive : undefined }));
  }),
  deleteCheckbook: withOwner(ownerOf, async (owner, req, res) => {
    await T.deleteCheckbook(owner, id(req.params.bookId));
    ok(res, "accDeleteCheckbook");
  }),
  trust: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accTrust", await T.listTrust(owner));
  }),
  saveTrust: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveTrust", await T.saveTrust(owner, { id: isId(b.id) ? String(b.id) : undefined, serial: str(b.serial, 40) || "", bank: str(b.bank, 80), amount: num(b.amount) || 0, dueDate: startOf(b.dueDate) || undefined, party: str(b.party, 30), partyName: str(b.partyName, 200), purpose: str(b.purpose, 300) }));
  }),
  releaseTrust: withOwner(ownerOf, async (owner, req, res) => {
    await T.releaseTrust(owner, id(req.params.trustId));
    ok(res, "accReleaseTrust");
  }),
  settings: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accSettings", await T.getSettings(owner));
  }),
  saveSettings: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSaveSettings", await T.saveSettings(owner, { negativeTreasury: str(b.negativeTreasury, 10), matchDays: num(b.matchDays) }));
  }),

  // ------------------------------------------------------------ requests
  // filing a finance request; the list, the decisions and «اجرا» are the
  // panel's «کارتابل» (Controllers/kartablController.ts)
  team: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accTeam", await R.team(owner));
  }),
  createRequest: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(
      res,
      "accCreateRequest",
      await R.createRequest(
        owner,
        {
          kind: b.kind as R.RequestInput["kind"],
          amount: num(b.amount),
          description: str(b.description),
          approvers: Array.isArray(b.approvers) ? (b.approvers as unknown[]).map(String) : [],
          money: str(b.money, 30),
          toMoney: str(b.toMoney, 30),
          account: str(b.account, 30),
          center: str(b.center, 30),
          party: str(b.party, 30),
          partyName: str(b.partyName, 200),
          payKind: b.payKind === "remittance" ? "remittance" : "payment",
          serial: str(b.serial, 40),
          bank: str(b.bank, 80),
          dueDate: startOf(b.dueDate) || undefined,
          invoice: str(b.invoice, 30),
          returnAction: b.returnAction === "refund" ? "refund" : "credit",
          payFrom: b.payFrom === "bank" ? "bank" : "cash",
        },
        req.user?._id,
      ),
      201,
    );
  }),

  // ---------------------------------------------- tax, health, sales tools
  seasonal: withOwner(ownerOf, async (owner, req, res) => {
    const year = Number(req.query.year);
    const quarter = Number(req.query.quarter);
    if (!Number.isInteger(year) || year < 1300 || year > 1600 || ![1, 2, 3, 4].includes(quarter)) throw new BadInputError();
    ok(res, "accSeasonal", await X.seasonalReport(owner, year, quarter));
  }),
  health: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accHealth", await X.dataHealth(owner));
  }),
  prices: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accPrices", await X.listPrices(owner, { q: str(q.q, 100), group: str(q.group, 80), all: q.all === "1" }));
  }),
  savePrice: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(res, "accSavePrice", await X.savePrice(owner, { id: isId(b.id) ? String(b.id) : undefined, code: str(b.code, 30), title: str(b.title, 200) || "", group: str(b.group, 80), unit: str(b.unit, 30), price: num(b.price) || 0, insurancePrice: num(b.insurancePrice) ?? null, taxRate: num(b.taxRate), account: str(b.account, 30), isActive: typeof b.isActive === "boolean" ? b.isActive : undefined }));
  }),
  deletePrice: withOwner(ownerOf, async (owner, req, res) => {
    await X.deletePrice(owner, id(req.params.priceId));
    ok(res, "accDeletePrice");
  }),
  proformas: withOwner(ownerOf, async (owner, _req, res) => {
    if (owner.kind === "platform") throw new NotFoundError();
    ok(res, "accProformas", await X.listProformas(owner));
  }),
  createProforma: withOwner(ownerOf, async (owner, req, res) => {
    if (owner.kind === "platform") throw new NotFoundError();
    ok(res, "accCreateProforma", await X.createProforma(owner, invoiceInput(body(req)), req.user?._id), 201);
  }),
  convertProforma: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accConvertProforma", await X.convertProforma(owner, id(req.params.invoiceId), body(req).issue === true, req.user?._id));
  }),
  quickInvoice: withOwner(ownerOf, async (owner, req, res) => {
    if (owner.kind === "platform") throw new NotFoundError();
    const b = body(req);
    const pay = b.pay && typeof b.pay === "object" ? (b.pay as Record<string, unknown>) : null;
    ok(
      res,
      "accQuickInvoice",
      await X.quickInvoice(
        owner,
        {
          invoice: invoiceInput(b),
          pay: pay && isId(pay.money) ? { money: String(pay.money), method: pay.method === "card" || pay.method === "transfer" ? pay.method : "cash", amount: num(pay.amount) } : null,
        },
        req.user?._id,
      ),
      201,
    );
  }),
  settlements: withOwner(ownerOf, async (owner, _req, res) => {
    if (owner.kind === "platform") throw new NotFoundError();
    ok(res, "accSettlements", await X.settlements(owner));
  }),
  allocateReceipt: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(
      res,
      "accAllocateReceipt",
      await X.allocateReceipt(
        owner,
        {
          money: String(b.money || ""),
          method: b.method === "card" || b.method === "transfer" ? b.method : "cash",
          date: docDate(b.date),
          reference: str(b.reference, 80),
          allocations: Array.isArray(b.allocations) ? (b.allocations as { invoice: string; amount: number }[]) : [],
        },
        req.user?._id,
      ),
      201,
    );
  }),
  // the per-profile entries and income view (Lib/business/accExtras.ts)
  profile: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accProfile", {
      kind: owner.kind,
      entries: Object.entries(X.PROFILE_ENTRIES)
        .filter(([, d]) => d.kinds.includes(owner.kind))
        .map(([k, d]) => ({ key: k, partyKind: d.partyKind, needsParty: !!d.partyOn, money: d.debit === "money" || d.credit === "money" })),
    });
  }),
  profileEntries: withOwner(ownerOf, async (owner, _req, res) => {
    ok(res, "accProfileEntries", await X.listProfileEntries(owner));
  }),
  profileEntry: withOwner(ownerOf, async (owner, req, res) => {
    const b = body(req);
    ok(
      res,
      "accProfileEntry",
      await X.profileEntry(owner, String(req.params.kind || ""), { amount: num(b.amount) || 0, date: docDate(b.date), party: str(b.party, 30), partyName: str(b.partyName, 200), money: str(b.money, 30), description: str(b.description, 300), release: b.release === true }, req.user?._id),
      201,
    );
  }),
  voidProfileEntry: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "accVoidProfileEntry", await X.voidProfileEntry(owner, id(req.params.voucherId), req.user?._id));
  }),
  profileIncome: withOwner(ownerOf, async (owner, req, res) => {
    const q = req.query as Record<string, unknown>;
    ok(res, "accProfileIncome", await X.profileIncome(owner, startOf(q.from), endOf(q.to)));
  }),
  xlsx: catchAsync(async (req: Request, res: Response) => {
    const b = body(req);
    const buf = await X.toXlsx({ title: str(b.title, 60), head: Array.isArray(b.head) ? (b.head as string[]) : [], rows: Array.isArray(b.rows) ? (b.rows as (string | number)[][]) : [], rtl: b.rtl === true });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="export.xlsx"`);
    res.status(200).send(buf);
  }),
});

const invoiceInput = (b: Record<string, unknown>) => {
  const party = (b.party && typeof b.party === "object" ? b.party : {}) as Record<string, unknown>;
  const insurer = b.insurer && typeof b.insurer === "object" ? (b.insurer as Record<string, unknown>) : null;
  return {
    date: docDate(b.date),
    dueDate: startOf(b.dueDate),
    party: { name: str(party.name, 200) || "", phone: str(party.phone, 30), nationalId: str(party.nationalId, 20) },
    doctorName: str(b.doctorName, 200),
    lines: Array.isArray(b.lines)
      ? (b.lines as Record<string, unknown>[]).slice(0, 100).map((l) => ({
          title: str(l?.title, 300) || "",
          qty: Number(l?.qty) || 1,
          unitPrice: Number(l?.unitPrice) || 0,
          discount: Number(l?.discount) || 0,
          taxRate: Number(l?.taxRate) || 0,
          account: isId(l?.account) ? String(l.account) : undefined,
          item: isId(l?.item) ? String(l.item) : undefined,
        }))
      : [],
    insurer: insurer && str(insurer.name) ? { kind: (str(insurer.kind, 20) || "other") as "other", name: str(insurer.name, 120) || "", share: Number(insurer.share) || 0 } : null,
    note: str(b.note, 1000),
    center: isId(b.center) ? String(b.center) : undefined,
  };
};
