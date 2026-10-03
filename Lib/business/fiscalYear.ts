import moment from "moment-jalaali";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizFiscalYear, { IBizFiscalYear } from "../../Models/BizFiscalYear";
import BizPayrun from "../../Models/BizPayrun";
import BizPurchase from "../../Models/BizPurchase";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { accountRows, trialBalance } from "./reports";
import { clearLockCache, postVoucher, PostLine } from "./voucher";

// Year-end close (2026-10, docs/business-suite.md phase 6), the way Iranian
// legal books (دفاتر قانونی) and Sepidar or Holoo do it. The fiscal year is
// the Jalali year as Tehran sees it (1 Farvardin to the last of Esfand).
// Closing a year writes three vouchers:
//   1. income and expense accounts closed into retained earnings (pl),
//   2. the اختتامیه: every balance-sheet account brought to zero on the last
//      day (final),
//   3. the افتتاحیه: the same balances opened on 1 Farvardin (open).
// Years close oldest first. A closed year is locked (Lib/business/voucher.ts
// lockedDate); only the latest closed one can be opened again.

// Tehran: UTC+03:30, no daylight saving since 1401
const TEHRAN = 210;

export const yearRange = (year: number) => {
  const start = moment.utc(`${year}/1/1`, "jYYYY/jM/jD").subtract(TEHRAN, "minutes");
  const next = moment.utc(`${year + 1}/1/1`, "jYYYY/jM/jD").subtract(TEHRAN, "minutes");
  return { start: start.toDate(), end: new Date(next.valueOf() - 1) };
};

export const yearOf = (d: Date) => moment(d).utcOffset(TEHRAN).jYear();

const round = (n: number) => Math.round(n * 100) / 100;

// what stands in the way of closing a year, and what is worth a look first
export const checklist = async (owner: BizOwner, year: number) => {
  const { start, end } = yearRange(year);
  const blockers: string[] = [];
  const warnings: { code: string; count: number }[] = [];
  if (end > new Date()) blockers.push("سال مالی هنوز تمام نشده است");
  const earlier = await BizVoucher.findOne({ ...ownerFilter(owner), date: { $lt: start } }).sort({ date: 1 }).select("date").lean<IBizVoucher>();
  if (earlier) {
    const first = yearOf(earlier.date);
    for (let y = first; y < year; y++)
      if (!(await BizFiscalYear.exists({ ...ownerFilter(owner), year: y }))) {
        blockers.push("ابتدا سال‌های قبل را ببندید");
        break;
      }
  }
  if (await BizFiscalYear.exists({ ...ownerFilter(owner), year })) blockers.push("این سال مالی قبلاً بسته شده است");
  const tb = await trialBalance(owner, null, end);
  if (!tb.balanced) blockers.push("تراز آزمایشی متوازن نیست");
  const drafts = await BizPayrun.countDocuments({ ...ownerFilter(owner), year, status: "draft" });
  if (drafts) warnings.push({ code: "payrollDraft", count: drafts });
  const purchases = await BizPurchase.countDocuments({ ...ownerFilter(owner), status: "draft", date: { $gte: start, $lte: end } });
  if (purchases) warnings.push({ code: "purchaseDraft", count: purchases });
  const manual = await BizVoucher.countDocuments({ ...ownerFilter(owner), kind: "manual", date: { $gte: start, $lte: end } });
  return { blockers, warnings, manual, balanced: tb.balanced };
};

// each detail account's cumulative balance up to the year's end, before
// any اختتامیه or افتتاحیه
const balancesAt = async (owner: BizOwner, end: Date) =>
  (await accountRows(owner, null, end)).filter((r) => r.level === "detail" && Math.abs(r.balance) >= 0.005);

const debitSide = (type: string) => type === "asset" || type === "expense";

// a line that brings an account's balance to zero
const zeroLine = (r: { _id: unknown; type: string; balance: number }, label?: string): PostLine => {
  const amount = round(Math.abs(r.balance));
  // a debit-nature account with a positive balance is credited, and so on
  const credit = debitSide(r.type) === r.balance > 0;
  return { accountId: String(r._id), label, debit: credit ? 0 : amount, credit: credit ? amount : 0 };
};

const flip = (l: PostLine): PostLine => ({ ...l, debit: l.credit || 0, credit: l.debit || 0 });

export const closeYear = async (owner: BizOwner, year: number, by?: unknown) => {
  const check = await checklist(owner, year);
  if (check.blockers.length) throw new AppError(check.blockers[0], 400);
  const { start, end } = yearRange(year);
  const nextStart = new Date(end.getTime() + 1);

  // 1. income and expense into retained earnings
  const before = await balancesAt(owner, end);
  const temporary = before.filter((r) => r.type === "income" || r.type === "expense");
  const profit = round(
    temporary.filter((r) => r.type === "income").reduce((s, r) => s + r.balance, 0) -
      temporary.filter((r) => r.type === "expense").reduce((s, r) => s + r.balance, 0),
  );
  let pl: IBizVoucher | null = null;
  if (temporary.length) {
    const lines = temporary.map((r) => zeroLine(r));
    if (Math.abs(profit) >= 0.005) lines.push({ role: "retainedEarnings", debit: profit < 0 ? -profit : 0, credit: profit > 0 ? profit : 0 });
    pl = await postVoucher(owner, {
      ref: `close:${year}:pl`,
      kind: "closing",
      phase: "pl",
      fiscalYear: year,
      date: end,
      description: "بستن حساب‌های درآمد و هزینه",
      lines,
      createdBy: by,
    });
  }

  // 2 and 3. every balance-sheet account to zero, and opened again
  const after = (await balancesAt(owner, end)).filter((r) => r.type === "asset" || r.type === "liability" || r.type === "equity");
  let final: IBizVoucher | null = null;
  let open: IBizVoucher | null = null;
  if (after.length >= 2) {
    const lines = after.map((r) => zeroLine(r));
    final = await postVoucher(owner, {
      ref: `close:${year}:final`,
      kind: "closing",
      phase: "final",
      fiscalYear: year,
      date: end,
      description: "سند اختتامیه",
      lines,
      createdBy: by,
    });
    open = await postVoucher(owner, {
      ref: `close:${year}:open`,
      kind: "opening",
      phase: "open",
      fiscalYear: year + 1,
      date: nextStart,
      description: "سند افتتاحیه",
      lines: lines.map(flip),
      createdBy: by,
    });
  }

  const doc = await BizFiscalYear.create({
    ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: owner.id }),
    year,
    start,
    end,
    profit,
    vouchers: { pl: pl?._id, final: final?._id, open: open?._id },
    closedBy: by,
  });
  clearLockCache();
  return doc.toObject() as IBizFiscalYear;
};

// the latest closed year only: its three vouchers go, the year is open again
export const reopenYear = async (owner: BizOwner, year: number) => {
  const latest = await BizFiscalYear.findOne(ownerFilter(owner)).sort({ year: -1 }).lean<IBizFiscalYear>();
  if (!latest || latest.year !== year) throw new AppError("فقط آخرین سال بسته‌شده دوباره باز می‌شود", 400);
  await BizVoucher.deleteMany({ ...ownerFilter(owner), ref: { $in: [`close:${year}:pl`, `close:${year}:final`, `close:${year}:open`] } });
  await BizFiscalYear.deleteOne({ _id: latest._id });
  clearLockCache();
};

// every year the books have touched, oldest first, with its state
export const yearsOverview = async (owner: BizOwner) => {
  const [first, closed] = await Promise.all([
    BizVoucher.findOne(ownerFilter(owner)).sort({ date: 1 }).select("date").lean<IBizVoucher>(),
    BizFiscalYear.find(ownerFilter(owner)).sort({ year: 1 }).lean<IBizFiscalYear[]>(),
  ]);
  const current = yearOf(new Date());
  const from = Math.min(first ? yearOf(first.date) : current, ...closed.map((c) => c.year));
  const latestClosed = closed.length ? closed[closed.length - 1].year : null;
  const rows = [];
  for (let y = from; y <= current; y++) {
    const c = closed.find((x) => x.year === y);
    const { start, end } = yearRange(y);
    const counts = await BizVoucher.countDocuments({ ...ownerFilter(owner), date: { $gte: start, $lte: end }, phase: { $exists: false } });
    rows.push({
      year: y,
      start,
      end,
      ended: end <= new Date(),
      closed: !!c,
      closedAt: c?.closedAt,
      profit: c?.profit,
      vouchers: counts,
      closingVouchers: c?.vouchers,
      canReopen: !!c && y === latestClosed,
    });
  }
  // the year to close next: the oldest that ended and is still open
  const next = rows.find((r) => r.ended && !r.closed);
  return { years: rows.reverse(), next: next ? { year: next.year, ...(await checklist(owner, next.year)) } : null };
};
