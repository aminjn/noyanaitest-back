import mongoose from "mongoose";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizAccount from "../../Models/BizAccount";
import BizFiscalYear from "../../Models/BizFiscalYear";
import AppError from "../AppError";
import BizCostCenter from "../../Models/BizCostCenter";
import { accountFor, BizOwner, ensureChart, ownerFilter } from "./coa";
import { PartyRef, resolveParty } from "./parties";

// The voucher engine (2026-10), after nexxacrm's postVoucher
// (lib/coa.ts): a voucher is balanced or it is refused; numbers are handed
// out atomically per owner; an automatic voucher carries a ref unique per
// owner, so the same event posted twice (a retry, the recovery sweep) is a
// no-op instead of a double entry.

const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const BizCounter =
  (mongoose.models.BizCounter as mongoose.Model<{ _id: string; seq: number }>) ||
  mongoose.model<{ _id: string; seq: number }>("BizCounter", CounterSchema);

export const nextNumber = async (owner: BizOwner) => {
  const id = `voucher:${owner.kind}:${owner.id || ""}`;
  const row = await BizCounter.findOneAndUpdate(
    { _id: id },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return row!.seq;
};

// the next number of any numbered document of an owner (invoices,
// payments, expenses, claims - Lib/business/finance.ts)
export const nextDocNumber = async (kind: string, owner: BizOwner) => {
  const row = await BizCounter.findOneAndUpdate(
    { _id: `${kind}:${owner.kind}:${owner.id || ""}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return row!.seq;
};

export type PostLine = {
  // a system role, or an account the caller already resolved
  role?: string;
  accountId?: string | mongoose.Types.ObjectId;
  label?: string;
  debit?: number;
  credit?: number;
  // the line's تفصیلی: a BizParty id, or who it is (found or created by
  // its key - Lib/business/parties.ts)
  party?: PartyRef;
  // the line's cost centre
  center?: unknown;
};

// The lines that carry a voucher's default party (PostInput.party) when
// they name none: what is owed by or to someone.
export const PARTY_ROLES = new Set([
  "receivable",
  "insuranceReceivable",
  "payable",
  "chequesReceivable",
  "chequesPayable",
  "employeeAdvances",
  "salaryPayable",
  "prepaid",
]);

export type PostInput = {
  ref?: string;
  // the year-end close's own vouchers (Lib/business/fiscalYear.ts), the
  // only ones written inside a closed year
  phase?: IBizVoucher["phase"];
  fiscalYear?: number;
  center?: unknown;
  date?: Date;
  kind?: IBizVoucher["kind"];
  description: string;
  source?: { type: string; id: unknown };
  lines: PostLine[];
  createdBy?: unknown;
  // the party of every line on a PARTY_ROLES account that names none
  party?: PartyRef;
  // a hand-typed voucher (Lib/business/journal.ts)
  state?: "draft" | "final";
  reference?: string;
  attachments?: string[];
  number?: number;
  // typed by hand (the closed-year and active-account rules): default for kind "manual"
  manual?: boolean;
};

// ------------------------------------------------------- closed years

const lockCache = new Map<string, { at: number; end: Date | null; year?: number }>();
export const clearLockCache = () => lockCache.clear();

// the end of the latest closed fiscal year of this owner, if any
export const closedUntil = async (owner: BizOwner) => {
  const key = `${owner.kind}:${owner.id || ""}`;
  const hit = lockCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const last = await BizFiscalYear.findOne(ownerFilter(owner)).sort({ year: -1 }).select("end year").lean<{ end: Date; year: number }>();
  const v = { at: Date.now(), end: last?.end || null, year: last?.year };
  lockCache.set(key, v);
  return v;
};

// A hand-typed voucher may not land in a closed year; an automatic one
// (a late settlement, a refund) is moved to the first moment of the open
// year and keeps its real date beside it.
export const lockedDate = async (owner: BizOwner, date: Date, manual: boolean) => {
  const { end, year } = await closedUntil(owner);
  if (!end || date > end) return { date, actualDate: undefined as Date | undefined };
  if (manual) throw new AppError("سال مالی ${1} بسته شده است؛ سند را با تاریخ سال باز ثبت کنید".replace("${1}", String(year)), 400);
  return { date: new Date(end.getTime() + 1), actualDate: date };
};

const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Resolves and checks a voucher's lines: detail accounts of this owner,
// parties and cost centres of this owner, no negative amounts, balanced and
// not zero. A hand-typed voucher (manual) may not use a deactivated account
// or a party of a kind its account does not take; a draft (draft) need not
// balance yet (Nexxa createManualEntry).
export const buildLines = async (
  owner: BizOwner,
  input: PostLine[],
  opts: { manual?: boolean; draft?: boolean; party?: PartyRef } = {},
) => {
  const lines = [];
  const centers = new Map<string, boolean>();
  for (const l of input) {
    const debit = round(l.debit || 0);
    const credit = round(l.credit || 0);
    if (!debit && !credit) continue;
    if (debit < 0 || credit < 0) throw new AppError("مبلغ ردیف سند نمی‌تواند منفی باشد", 400);
    if (debit && credit) throw new AppError("هر ردیف سند یا بدهکار است یا بستانکار", 400);
    const acc = l.role
      ? await accountFor(owner, l.role)
      : await BizAccount.findOne({ ...ownerFilter(owner), _id: l.accountId }).lean();
    if (!acc) throw new AppError("حساب ردیف سند پیدا نشد", 400);
    if (acc.level !== "detail") throw new AppError("فقط حساب‌های معین ردیف سند می‌گیرند", 400);
    if (opts.manual && acc.isActive === false) throw new AppError("این حساب غیرفعال است و ردیف تازه نمی‌گیرد", 400);
    const ref = l.party ?? (opts.party && (PARTY_ROLES.has(acc.role || "") || acc.tafsiliKinds?.length) ? opts.party : undefined);
    const party = ref ? await resolveParty(owner, ref) : null;
    if (ref && !party && opts.manual) throw new AppError("تفصیلی ردیف سند پیدا نشد", 400);
    if (party && opts.manual && acc.tafsiliKinds?.length && !acc.tafsiliKinds.includes(party.kind))
      throw new AppError("این تفصیلی به این حساب معین نمی‌خورد", 400);
    let center: mongoose.Types.ObjectId | undefined;
    if (l.center && mongoose.isValidObjectId(String(l.center))) {
      const key = String(l.center);
      if (!centers.has(key)) centers.set(key, !!(await BizCostCenter.exists({ ...ownerFilter(owner), _id: key })));
      if (centers.get(key)) center = new mongoose.Types.ObjectId(key);
      else if (opts.manual) throw new AppError("مرکز هزینه پیدا نشد", 400);
    }
    lines.push({
      account: acc._id,
      code: acc.code,
      label: l.label,
      debit,
      credit,
      ...(party ? { party: party._id } : {}),
      ...(center ? { center } : {}),
    });
  }
  const debit = round(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round(lines.reduce((s, l) => s + l.credit, 0));
  if (lines.length < 2) throw new AppError("سند نامتوازن است؛ جمع بدهکار و بستانکار باید برابر و بیشتر از صفر باشد", 400);
  if (!opts.draft && (!debit || Math.abs(debit - credit) > 0.01))
    throw new AppError("سند نامتوازن است؛ جمع بدهکار و بستانکار باید برابر و بیشتر از صفر باشد", 400);
  return { lines, total: Math.max(debit, credit) };
};

export const postVoucher = async (owner: BizOwner, input: PostInput): Promise<IBizVoucher | null> => {
  await ensureChart(owner);
  if (input.ref) {
    const existing = await BizVoucher.findOne({ ...ownerFilter(owner), ref: input.ref }).lean<IBizVoucher>();
    if (existing) return existing;
  }
  const manual = input.manual ?? input.kind === "manual";
  const draft = input.state === "draft";
  const { lines, total } = await buildLines(owner, input.lines, { manual, draft, party: input.party });
  const placed = input.phase
    ? { date: input.date || new Date(), actualDate: undefined }
    : await lockedDate(owner, input.date || new Date(), manual);

  const number = input.number || (await nextNumber(owner));
  try {
    const doc = await BizVoucher.create({
      ...(owner.kind === "platform" || !owner.id
        ? { ownerKind: owner.kind }
        : { ownerKind: owner.kind, ownerId: owner.id }),
      number,
      date: placed.date,
      actualDate: placed.actualDate,
      phase: input.phase,
      fiscalYear: input.fiscalYear,
      center: input.center || undefined,
      kind: input.kind || "auto",
      ref: input.ref,
      description: input.description,
      source: input.source?.id ? { type: input.source.type, id: input.source.id } : undefined,
      lines,
      total,
      createdBy: input.createdBy,
      ...(input.state ? { state: input.state } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    return doc.toObject() as IBizVoucher;
  } catch (err: any) {
    // the same ref posted concurrently: the other one won
    if (err?.code === 11000 && input.ref) return null;
    throw err;
  }
};
