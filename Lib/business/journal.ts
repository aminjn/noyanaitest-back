import mongoose from "mongoose";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizVoucherAudit, { AuditSnapshot, bizAuditActions } from "../../Models/BizVoucherAudit";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizParty from "../../Models/BizParty";
import AppError from "../AppError";
import { accountFor, BizOwner, displayName, ensureChart, ownerFilter } from "./coa";
import { buildLines, closedUntil, lockedDate, postVoucher, PostLine } from "./voucher";
import { parseCoding } from "./accCore";
import { partyNames, PartyRef, resolveParty } from "./parties";
import { Locale } from "../locales";

// The journal (دفتر روزنامه) and hand-typed vouchers (2026-10), a faithful
// port of Nexxa's accounting/journal + journal/new + the manual-entry
// actions (createManualEntry, finalizeManualEntry, revertManualEntryToDraft,
// updateManualEntry, deleteManualEntry) onto the one Noyan engine:
//   - a manual voucher is saved as a draft (it need not balance yet) or
//     final (it must balance);
//   - a draft becomes final only balanced; a final one goes back to draft to
//     be corrected, keeping its number;
//   - only manual vouchers are edited or deleted; automatic ones change
//     through their documents;
//   - nothing changes inside a closed fiscal year;
//   - every change is written to the audit trail (BizVoucherAudit).
// A draft is invisible to every report (Models/BizVoucher.ts hooks).

export type ManualLine = { account: string; party?: string | null; center?: string | null; label?: string; debit: number; credit: number };
export type ManualInput = {
  date: Date;
  description: string;
  reference?: string;
  center?: string | null;
  state: "draft" | "final";
  lines: ManualLine[];
  attachments?: string[];
};

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));

export const snapshot = (v: Pick<IBizVoucher, "date" | "description" | "total" | "lines"> & { state?: string; reference?: string }): AuditSnapshot => ({
  date: v.date,
  description: v.description,
  reference: v.reference,
  state: v.state || "final",
  total: v.total,
  lines: (v.lines || []).map((l) => ({ code: l.code, party: l.party ? String(l.party) : undefined, label: l.label, debit: l.debit, credit: l.credit })),
});

export const audit = async (
  owner: BizOwner,
  v: Pick<IBizVoucher, "_id" | "number">,
  action: (typeof bizAuditActions)[number],
  by: unknown,
  before?: AuditSnapshot,
  after?: AuditSnapshot,
) =>
  BizVoucherAudit.create({
    ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) }),
    voucher: v._id,
    number: v.number,
    action,
    by: by && mongoose.isValidObjectId(String(by)) ? oid(by) : undefined,
    before,
    after,
  }).catch((err) => console.log("[accounting] audit failed:", err?.message));

const toPostLines = (lines: ManualLine[]): PostLine[] =>
  (Array.isArray(lines) ? lines : [])
    .filter((l) => l && mongoose.isValidObjectId(String(l.account)) && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))
    .map((l) => ({
      accountId: String(l.account),
      party: l.party && mongoose.isValidObjectId(String(l.party)) ? String(l.party) : undefined,
      center: l.center && mongoose.isValidObjectId(String(l.center)) ? String(l.center) : undefined,
      label: (l.label || "").trim().slice(0, 300) || undefined,
      debit: Math.max(0, Number(l.debit) || 0),
      credit: Math.max(0, Number(l.credit) || 0),
    }));

const isManual = (v: Pick<IBizVoucher, "kind" | "phase" | "source">) => v.kind === "manual" && !v.phase;

// a voucher of a closed year stays as it is
const assertNotClosed = async (owner: BizOwner, date: Date) => {
  const { end, year } = await closedUntil(owner);
  if (end && date <= end) throw new AppError("سال مالی ${1} بسته شده است؛ سند را با تاریخ سال باز ثبت کنید".replace("${1}", String(year)), 400);
};

// Creates a hand-typed voucher, as a draft or final (Nexxa createManualEntry).
export const createManualVoucher = async (owner: BizOwner, input: ManualInput, by?: unknown) => {
  const lines = toPostLines(input.lines);
  if (lines.length < 2) throw new AppError("شرح سند و دست‌کم دو ردیف را وارد کنید", 400);
  const v = await postVoucher(owner, {
    kind: "manual",
    state: input.state,
    date: input.date,
    description: (input.description || "").trim().slice(0, 500),
    reference: input.reference?.trim().slice(0, 80) || undefined,
    center: input.center && mongoose.isValidObjectId(input.center) ? input.center : undefined,
    attachments: (input.attachments || []).filter((a) => typeof a === "string").slice(0, 20),
    lines,
    createdBy: by,
  });
  if (!v) throw new AppError("سند ثبت نشد", 400);
  await audit(owner, v, "create", by, undefined, snapshot(v));
  return v;
};

// The callable form for the other modules (the AI drafting of a voucher):
// always a draft, to be reviewed and finalized by a person.
export const createDraftVoucher = (owner: BizOwner, input: Omit<ManualInput, "state">, by?: unknown) =>
  createManualVoucher(owner, { ...input, state: "draft" }, by);

const findManual = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("سند پیدا نشد", 404);
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id }).setOptions({ withDrafts: true });
  if (!v) throw new AppError("سند پیدا نشد", 404);
  if (!isManual(v)) throw new AppError("سندهای خودکار از رویدادهای واقعی ساخته شده‌اند و ویرایش نمی‌شوند", 400);
  return v;
};

// Rewrites a manual voucher - header and lines - keeping its number
// (Nexxa updateManualEntry); the state follows what is asked.
export const updateManualVoucher = async (owner: BizOwner, id: string, input: ManualInput, by?: unknown) => {
  const v = await findManual(owner, id);
  await assertNotClosed(owner, v.date);
  await assertNotClosed(owner, input.date || v.date);
  const before = snapshot(v);
  const draft = input.state === "draft";
  const { lines, total } = await buildLines(owner, toPostLines(input.lines), { manual: true, draft });
  if (!draft) await lockedDate(owner, input.date || v.date, true);
  v.set({
    date: input.date || v.date,
    description: (input.description || "").trim().slice(0, 500),
    reference: input.reference?.trim().slice(0, 80) || undefined,
    center: input.center && mongoose.isValidObjectId(input.center) ? oid(input.center) : undefined,
    state: input.state,
    lines,
    total,
  });
  if (input.attachments) v.set("attachments", input.attachments.filter((a) => typeof a === "string").slice(0, 20));
  await v.save();
  await audit(owner, v, "update", by, before, snapshot(v));
  return v.toObject();
};

// draft -> final, only balanced (Nexxa finalizeManualEntry)
export const finalizeVoucher = async (owner: BizOwner, id: string, by?: unknown) => {
  const v = await findManual(owner, id);
  if (v.state !== "draft") throw new AppError("این سند پیش‌نویس نیست", 400);
  await lockedDate(owner, v.date, true);
  const { lines, total } = await buildLines(
    owner,
    v.lines.map((l) => ({ accountId: l.account, party: l.party, center: l.center, label: l.label, debit: l.debit, credit: l.credit })),
    { manual: true },
  );
  const before = snapshot(v);
  v.set({ state: "final", lines, total, approvedBy: by && mongoose.isValidObjectId(String(by)) ? oid(by) : undefined, approvedAt: new Date() });
  await v.save();
  await audit(owner, v, "finalize", by, before, snapshot(v));
  return v.toObject();
};

// final -> draft, to correct it (Nexxa revertManualEntryToDraft)
export const revertVoucher = async (owner: BizOwner, id: string, by?: unknown) => {
  const v = await findManual(owner, id);
  if (v.state === "draft") throw new AppError("این سند هم‌اکنون پیش‌نویس است", 400);
  await assertNotClosed(owner, v.date);
  const before = snapshot(v);
  v.set({ state: "draft", approvedBy: undefined, approvedAt: undefined });
  await v.save();
  await audit(owner, v, "revert", by, before, snapshot(v));
  return v.toObject();
};

// Nexxa deleteManualEntry: only manual vouchers, never in a closed year
export const deleteManualVoucher = async (owner: BizOwner, id: string, by?: unknown) => {
  const v = await findManual(owner, id);
  await assertNotClosed(owner, v.date);
  const before = snapshot(v);
  await BizVoucher.deleteOne({ _id: v._id });
  await audit(owner, v, "delete", by, before);
};

// the scans behind a voucher - any voucher, a document is not accounting data
export const setAttachments = async (owner: BizOwner, id: string, attachments: string[], by?: unknown) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("سند پیدا نشد", 404);
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id }).setOptions({ withDrafts: true });
  if (!v) throw new AppError("سند پیدا نشد", 404);
  const before = (v.attachments || []).length;
  v.set("attachments", attachments.filter((a) => typeof a === "string" && a.length < 500).slice(0, 20));
  await v.save();
  await audit(owner, v, "attach", by, { total: before }, { total: (v.attachments || []).length });
  return v.toObject();
};

const escape = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const latinDigits = (q: string) => q.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

export type JournalQuery = {
  q?: string;
  kind?: string;
  state?: "draft" | "final";
  from?: Date | null;
  to?: Date | null;
  account?: string;
  party?: string;
  center?: string;
  page: number;
  limit: number;
};

// The journal: vouchers with their lines, newest first, searchable by
// number, description, reference, a line's label, account or party (Nexxa
// journalSearch), drafts included and marked.
export const listJournal = async (owner: BizOwner, q: JournalQuery, locale: Locale) => {
  await ensureChart(owner);
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.kind === "auto" || q.kind === "manual" || q.kind === "opening" || q.kind === "closing") filter.kind = q.kind;
  if (q.state === "draft") filter.state = "draft";
  else if (q.state === "final") filter.state = { $ne: "draft" };
  if (q.account && mongoose.isValidObjectId(q.account)) {
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: q.account }).lean<IBizAccount>();
    if (acc) filter["lines.code"] = acc.level === "detail" ? acc.code : { $regex: `^${escape(acc.code)}` };
  }
  if (q.party && mongoose.isValidObjectId(q.party)) filter["lines.party"] = oid(q.party);
  if (q.center && mongoose.isValidObjectId(q.center)) filter.$and = [{ $or: [{ center: oid(q.center) }, { "lines.center": oid(q.center) }] }];
  const term = q.q?.trim();
  if (term) {
    const r = new RegExp(escape(term), "i");
    const or: Record<string, unknown>[] = [{ description: r }, { reference: r }, { "lines.label": r }];
    const n = Number(latinDigits(term).replace(/\D/g, ""));
    if (n && Number.isSafeInteger(n)) or.push({ number: n });
    const accs = await BizAccount.find({ ...ownerFilter(owner), $or: [{ name: r }, { code: r }] }).select("code").lean<{ code: string }[]>();
    if (accs.length) or.push({ "lines.code": { $in: accs.map((a) => a.code) } });
    const parties = await BizParty.find({ ...ownerFilter(owner), $or: [{ name: r }, { code: r }] }).select("_id").limit(200).lean();
    if (parties.length) or.push({ "lines.party": { $in: parties.map((p) => p._id) } });
    filter.$or = or;
  }
  const [items, total] = await Promise.all([
    BizVoucher.find(filter).setOptions({ withDrafts: true }).sort({ date: -1, number: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<IBizVoucher[]>(),
    BizVoucher.countDocuments(filter).setOptions({ withDrafts: true }),
  ]);
  return { items: await withNames(owner, items, locale), total, page: q.page, limit: q.limit };
};

// lines with their account and party names, for display and export
export const withNames = async (owner: BizOwner, vouchers: IBizVoucher[], locale: Locale) => {
  const codes = [...new Set(vouchers.flatMap((v) => (v.lines || []).map((l) => l.code)))];
  const accounts = new Map(
    (await BizAccount.find({ ...ownerFilter(owner), code: { $in: codes } }).select("code name role").lean<IBizAccount[]>()).map((a) => [a.code, a]),
  );
  const parties = await partyNames(vouchers.flatMap((v) => (v.lines || []).map((l) => l.party)));
  return vouchers.map((v) => ({
    ...v,
    state: v.state || "final",
    manual: isManual(v),
    lines: (v.lines || []).map((l) => {
      const a = accounts.get(l.code);
      return {
        ...l,
        accountName: a ? displayName(a, locale) : "",
        party: l.party ? parties.get(String(l.party)) || null : null,
      };
    }),
  }));
};

export const voucherHistory = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) return [];
  return BizVoucherAudit.find({ ...ownerFilter(owner), voucher: oid(id) })
    .sort({ createdAt: 1 })
    .populate({ path: "by", select: "firstName lastName phone" })
    .lean();
};

// every change of every manual voucher, newest first (the audit page)
export const auditLog = async (owner: BizOwner, q: { from?: Date | null; to?: Date | null; action?: string; page: number; limit: number }) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (q.action && (bizAuditActions as readonly string[]).includes(q.action)) filter.action = q.action;
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [items, total] = await Promise.all([
    BizVoucherAudit.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate({ path: "by", select: "firstName lastName phone" })
      .lean(),
    BizVoucherAudit.countDocuments(filter),
  ]);
  return { items, total };
};

// ------------------------------------------------ opening balances

export type OpeningRow = { code?: string; account?: string; party?: string | null; partyName?: string; debit: number; credit: number; label?: string };

// One opening voucher from rows of «code / debit / credit» (Nexxa
// importOpeningBalances, from Excel or typed on the opening form): codes
// that are not a detail account of this chart are skipped, and the
// difference is balanced on «تراز افتتاحیه» (5103). Kind "opening", dated
// on the day asked (the first day of the year by default).
export const importOpeningBalances = async (owner: BizOwner, rows: OpeningRow[], date: Date, by?: unknown) => {
  await ensureChart(owner);
  const accounts = await BizAccount.find({ ...ownerFilter(owner), level: "detail" }).lean<IBizAccount[]>();
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const lines: PostLine[] = [];
  const skipped: string[] = [];
  const latin = (s: unknown) => latinDigits(String(s ?? "")).trim();
  for (const r of Array.isArray(rows) ? rows : []) {
    const debit = Math.max(0, Math.round(Number(latin(r.debit).replace(/[^\d.]/g, "")) || 0));
    const credit = Math.max(0, Math.round(Number(latin(r.credit).replace(/[^\d.]/g, "")) || 0));
    if (!debit && !credit) continue;
    const acc = (r.account && byId.get(String(r.account))) || byCode.get(latin(r.code));
    if (!acc || acc.isActive === false) {
      skipped.push(latin(r.code) || String(r.account || ""));
      continue;
    }
    let party: PartyRef | undefined;
    if (r.party && mongoose.isValidObjectId(String(r.party))) party = String(r.party);
    else if (r.partyName?.trim())
      party = { kind: acc.role === "insuranceReceivable" ? "insurer" : acc.type === "liability" ? "supplier" : acc.role === "receivable" ? "patient" : "custom", name: r.partyName.trim() };
    const net = debit - credit;
    if (!net) continue;
    lines.push({ accountId: acc._id, party, label: r.label?.slice(0, 300) || "مانده‌ی اول دوره", debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  if (!lines.length) throw new AppError("هیچ ردیف معتبری برای مانده‌ی اول دوره پیدا نشد", 400);
  const d = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const c = lines.reduce((s, l) => s + (l.credit || 0), 0);
  let balancedBy = 0;
  if (Math.abs(d - c) > 0.5) {
    const opening = await accountFor(owner, "openingBalance");
    balancedBy = d - c;
    lines.push({ accountId: opening._id, label: "تراز افتتاحیه", debit: balancedBy < 0 ? -balancedBy : 0, credit: balancedBy > 0 ? balancedBy : 0 });
  }
  const v = await postVoucher(owner, {
    kind: "opening",
    manual: true,
    date,
    description: "سند افتتاحیه (مانده‌ی اول دوره)",
    reference: "OB",
    lines,
    createdBy: by,
  });
  if (!v) throw new AppError("سند ثبت نشد", 400);
  await audit(owner, v, "import", by, undefined, snapshot(v));
  return { voucher: v, posted: lines.length, skipped, balancedBy };
};

// A party's own opening balance (Nexxa contact-opening): what a patient
// owed us (debit) or we owed a supplier (credit) when the books began.
export const postPartyOpening = async (owner: BizOwner, partyId: string, amount: number, side: "debit" | "credit", date: Date, by?: unknown) => {
  const party = await resolveParty(owner, partyId);
  if (!party) throw new AppError("تفصیلی پیدا نشد", 404);
  const value = Math.round(Number(amount) || 0);
  if (value <= 0) throw new AppError("مبلغ را وارد کنید", 400);
  const role = side === "debit" ? (party.kind === "insurer" ? "insuranceReceivable" : "receivable") : "payable";
  const lines: PostLine[] =
    side === "debit"
      ? [
          { role, party: party._id, label: "مانده‌ی اولیه (بدهکار)", debit: value },
          { role: "openingBalance", label: "مانده‌ی اولیه‌ی طرف حساب", credit: value },
        ]
      : [
          { role: "openingBalance", label: "مانده‌ی اولیه‌ی طرف حساب", debit: value },
          { role, party: party._id, label: "مانده‌ی اولیه (بستانکار)", credit: value },
        ];
  const v = await postVoucher(owner, { ref: `opening:party:${party._id}`, kind: "opening", manual: true, date, description: "مانده‌ی اولیه‌ی طرف حساب", lines, createdBy: by });
  await BizParty.updateOne({ _id: party._id }, { $set: { openingPosted: true } });
  return v;
};

// ------------------------------------------------- coding import

// Adds the accounts of a «code name» list (Nexxa importCoding): the level
// from the code's length, the parent from the longest prefix (in the list
// or the chart), the type from the first digit. Existing codes are left as
// they are; a row whose parent is missing or of the wrong level is skipped.
export const importCoding = async (owner: BizOwner, text: string) => {
  await ensureChart(owner);
  const rows = parseCoding(String(text || "").slice(0, 200_000));
  if (!rows.length) throw new AppError("فهرست کدینگ خالی یا نامعتبر است؛ هر خط «کد نام» باشد", 400);
  const existing = await BizAccount.find(ownerFilter(owner)).select("code level type").lean<IBizAccount[]>();
  const known = new Map(existing.map((a) => [a.code, a.level]));
  const ownerFields = owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };
  let added = 0;
  const skipped: string[] = [];
  for (const r of rows.sort((a, b) => a.code.length - b.code.length)) {
    if (known.has(r.code)) continue;
    const parentLevel = r.parent ? known.get(r.parent) : undefined;
    const ok = r.level === "group" ? !r.parent : r.level === "total" ? parentLevel === "group" : parentLevel === "total";
    if (!ok) {
      skipped.push(r.code);
      continue;
    }
    await BizAccount.create({ ...ownerFields, code: r.code, name: r.name, type: r.type, level: r.level, parentCode: r.level === "group" ? undefined : r.parent }).catch(() => skipped.push(r.code));
    known.set(r.code, r.level);
    added++;
  }
  return { added, skipped };
};
