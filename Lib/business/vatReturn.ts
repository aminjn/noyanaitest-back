import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizVoucher from "../../Models/BizVoucher";
import BizAccount from "../../Models/BizAccount";
import BizPurchase, { IBizPurchase } from "../../Models/BizPurchase";
import BizSupplier, { IBizSupplier } from "../../Models/BizSupplier";
import BizVatQuarter, { IBizVatQuarter } from "../../Models/BizVatQuarter";
import MoadianInvoice, { IMoadianInvoice } from "../../Models/MoadianInvoice";
import AppError from "../AppError";
import { BizOwner, accountFor, ownerFilter } from "./coa";
import { accountRows } from "./reports";
import { postVoucher, PostLine } from "./voucher";
import { moadianCredit } from "./purchaseInvoices";
import BizPurchaseInvoice from "../../Models/BizPurchaseInvoice";

// The quarterly VAT return (اظهارنامه‌ی فصلی ارزش افزوده, 2026-10). Iran's
// VAT is filed every three Jalali months, by the 15th of the month after
// the quarter. Since the Moadian system the portal fills the sales side from
// the electronic invoices, so this report shows the same figures:
//   - sales: the quarter's Moadian invoices by VAT rate (corrections and
//     originals added, cancellations and returns taken off), registered and
//     still pending apart;
//   - purchases: VAT paid on purchases, creditable only when the supplier
//     has an economic code (a seller registered with the tax office), the
//     rest not creditable;
//   - the books: output VAT (3307) and input VAT (1510) of the quarter.
// Settling a quarter (تهاتر) posts one voucher at the quarter's end: output
// offset against creditable input and the credit carried from before, the
// non-creditable VAT to expense (7215). What is left of 3307 is payable to
// the tax office (paid with a second voucher); what is left of 1510 is the
// credit carried to the next quarter. Quarters settle oldest first.

const TEHRAN = 210;
const round = (n: number) => Math.round(n * 100) / 100;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));

export const quarterRange = (year: number, quarter: number) => {
  const start = moment.utc(`${year}/${quarter * 3 - 2}/1`, "jYYYY/jM/jD").subtract(TEHRAN, "minutes");
  const next = (quarter < 4 ? moment.utc(`${year}/${quarter * 3 + 1}/1`, "jYYYY/jM/jD") : moment.utc(`${year + 1}/1/1`, "jYYYY/jM/jD")).subtract(TEHRAN, "minutes");
  // the return is due by the 15th of the month after the quarter
  const due = next.clone().add(15, "days").subtract(1, "ms");
  return { start: start.toDate(), end: new Date(next.valueOf() - 1), due: due.toDate() };
};

export const quarterOf = (d: Date) => {
  const m = moment(d).utcOffset(TEHRAN);
  return { year: m.jYear(), quarter: Math.floor(m.jMonth() / 3) + 1 };
};

const REF = (year: number, quarter: number, seq: number) => `vat:${year}-${quarter}:${seq}`;
const notSettlement = { $not: /^vat:/ };

const codeOf = async (owner: BizOwner, role: string) => {
  try {
    return (await accountFor(owner, role)).code;
  } catch {
    return null; // the platform keeps no purchase VAT
  }
};

// the quarter's VAT in the books, settlements left out
type Credit = Awaited<ReturnType<typeof moadianCredit>>;

const booksOf = async (owner: BizOwner, start: Date, end: Date, credit: Credit) => {
  const [outCode, inCode] = await Promise.all([codeOf(owner, "vatPayable"), codeOf(owner, "vatReceivable")]);
  const codes = [outCode, inCode].filter(Boolean) as string[];
  const rows = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), date: { $gte: start, $lte: end }, ref: notSettlement, phase: { $nin: ["pl", "final", "open"] } } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $in: codes } } },
    { $group: { _id: { code: "$lines.code", type: "$source.type", id: "$source.id" }, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  let output = 0;
  let input = 0;
  const byPurchase = new Map<string, number>();
  const byInvoice = new Map<string, number>();
  for (const r of rows) {
    if (r._id.code === outCode) output += r.c - r.d;
    else {
      input += r.d - r.c;
      const id = r._id.id ? String(r._id.id) : "";
      if (r._id.type === "purchase" && id) byPurchase.set(id, (byPurchase.get(id) || 0) + r.d - r.c);
      if (r._id.type === "purchaseinvoice" && id) byInvoice.set(id, (byInvoice.get(id) || 0) + r.d - r.c);
    }
  }
  // an expense booked from a Moadian invoice the buyer later rejected
  let nonCreditable = 0;
  if (byInvoice.size) {
    const rejected = await BizPurchaseInvoice.find({ _id: { $in: [...byInvoice.keys()].map(oid) }, rejected: true }).select("_id").lean();
    for (const r of rejected) nonCreditable += byInvoice.get(String(r._id)) || 0;
  }
  // with Moadian invoices brought in for the quarter, a purchase's VAT is
  // creditable only when one of them backs it
  if (credit) {
    for (const [id, v] of byPurchase) if (!credit.purchases.has(id)) nonCreditable += v;
    return { outCode, inCode, output: round(output), input: round(input), nonCreditable: round(nonCreditable), creditable: round(input - nonCreditable) };
  }
  // before that, only from a supplier with an economic code
  const purchases = byPurchase.size
    ? await BizPurchase.find({ _id: { $in: [...byPurchase.keys()].map(oid) } }).select("supplier").lean<Pick<IBizPurchase, "_id" | "supplier">[]>()
    : [];
  const suppliers = purchases.length
    ? await BizSupplier.find({ _id: { $in: purchases.map((p) => p.supplier) } }).select("economicCode").lean<Pick<IBizSupplier, "_id" | "economicCode">[]>()
    : [];
  const coded = new Set(suppliers.filter((s) => (s.economicCode || "").trim()).map((s) => String(s._id)));
  for (const p of purchases) if (!coded.has(String(p.supplier))) nonCreditable += byPurchase.get(String(p._id)) || 0;
  return { outCode, inCode, output: round(output), input: round(input), nonCreditable: round(nonCreditable), creditable: round(input - nonCreditable) };
};

// the quarter's sales as the Moadian portal will show them (rials -> toman)
const salesOf = async (owner: BizOwner, start: Date, end: Date) => {
  const list = await MoadianInvoice.find({ ...ownerFilter(owner), issuedAt: { $gte: start, $lte: end }, status: { $ne: "Dropped" } })
    .select("subject status items")
    .lean<Pick<IMoadianInvoice, "subject" | "status" | "items">[]>();
  const rates = new Map<number, { rate: number; base: number; vat: number }>();
  const state = { registered: 0, pending: 0, rejected: 0 };
  for (const inv of list) {
    const sign = inv.subject === 3 || inv.subject === 4 ? -1 : 1;
    const bucket = inv.status === "Accepted" ? "registered" : inv.status === "Rejected" ? "rejected" : "pending";
    state[bucket]++;
    if (bucket !== "registered") continue;
    for (const i of inv.items || []) {
      const r = rates.get(i.vra) || { rate: i.vra, base: 0, vat: 0 };
      r.base += (sign * (i.adis || 0)) / 10;
      r.vat += (sign * (i.vam || 0)) / 10;
      rates.set(i.vra, r);
    }
  }
  const byRate = [...rates.values()].map((r) => ({ ...r, base: round(r.base), vat: round(r.vat) })).sort((a, b) => b.rate - a.rate);
  return {
    byRate,
    taxable: round(byRate.filter((r) => r.rate > 0).reduce((s, r) => s + r.base, 0)),
    exempt: round(byRate.filter((r) => r.rate === 0).reduce((s, r) => s + r.base, 0)),
    vat: round(byRate.reduce((s, r) => s + r.vat, 0)),
    ...state,
  };
};

// the quarter's purchases, creditable or not: backed by a Moadian invoice
// once any were brought in for the quarter, by the supplier's economic code
// before that
const purchasesOf = async (owner: BizOwner, start: Date, end: Date, credit: Credit) => {
  const list = await BizPurchase.find({ ...ownerFilter(owner), status: "received", date: { $gte: start, $lte: end } })
    .select("supplier subtotal discount tax")
    .lean<Pick<IBizPurchase, "_id" | "supplier" | "subtotal" | "discount" | "tax">[]>();
  const suppliers = list.length
    ? await BizSupplier.find({ _id: { $in: list.map((p) => p.supplier) } }).select("economicCode").lean<Pick<IBizSupplier, "_id" | "economicCode">[]>()
    : [];
  const coded = new Set(suppliers.filter((s) => (s.economicCode || "").trim()).map((s) => String(s._id)));
  const sum = (rows: typeof list) => ({
    count: rows.length,
    base: round(rows.reduce((s, p) => s + (p.subtotal || 0) - (p.discount || 0), 0)),
    vat: round(rows.reduce((s, p) => s + (p.tax || 0), 0)),
  });
  const ok = (p: (typeof list)[number]) => (credit ? credit.purchases.has(String(p._id)) : coded.has(String(p.supplier)));
  return {
    basis: credit ? ("moadian" as const) : ("economicCode" as const),
    withCode: sum(list.filter(ok)),
    withoutCode: sum(list.filter((p) => !ok(p))),
    moadian: credit ? { count: credit.count, open: credit.open, rejected: credit.rejected, vat: credit.vat } : null,
  };
};

// the credit carried into a quarter (what is left of 1510 before it) and
// what earlier settled quarters still owe the tax office
const balancesBefore = async (owner: BizOwner, start: Date, inCode: string | null) => {
  const rows = inCode ? await accountRows(owner, null, new Date(start.getTime() - 1)) : [];
  const carried = inCode ? rows.find((r) => r.code === inCode)?.balance || 0 : 0;
  const owed = await BizVatQuarter.find({ ...ownerFilter(owner), end: { $lt: start }, paidAt: { $exists: false }, payable: { $gt: 0 } })
    .select("payable")
    .lean<{ payable: number }[]>();
  return { carried: round(Math.max(0, carried)), unpaid: round(owed.reduce((s, q) => s + q.payable, 0)) };
};

const own = (owner: BizOwner) => ownerFilter(owner);

// the first quarter the books touched VAT in
const firstQuarter = async (owner: BizOwner) => {
  const codes = (await Promise.all([codeOf(owner, "vatPayable"), codeOf(owner, "vatReceivable")])).filter(Boolean);
  const first = await BizVoucher.findOne({ ...ownerFilter(owner), "lines.code": { $in: codes }, phase: { $nin: ["final", "open"] } })
    .sort({ date: 1 })
    .select("date")
    .lean<{ date: Date }>();
  return first ? quarterOf(first.date) : null;
};

const before = (a: { year: number; quarter: number }, b: { year: number; quarter: number }) =>
  a.year < b.year || (a.year === b.year && a.quarter < b.quarter);

const previous = (q: { year: number; quarter: number }) => (q.quarter > 1 ? { year: q.year, quarter: q.quarter - 1 } : { year: q.year - 1, quarter: 4 });

// the full report of one quarter
export const vatQuarter = async (owner: BizOwner, year: number, quarter: number) => {
  const range = quarterRange(year, quarter);
  const credit = await moadianCredit(owner, range.start, range.end);
  const [books, sales, purchases, settled] = await Promise.all([
    booksOf(owner, range.start, range.end, credit),
    salesOf(owner, range.start, range.end),
    purchasesOf(owner, range.start, range.end, credit),
    BizVatQuarter.findOne({ ...own(owner), year, quarter }).lean<IBizVatQuarter>(),
  ]);
  const { carried, unpaid } = await balancesBefore(owner, range.start, books.inCode);
  const available = round(carried + books.creditable);
  const offset = round(Math.max(0, Math.min(books.output, available)));
  const figures = settled
    ? { output: settled.output, creditable: settled.creditable, nonCreditable: settled.nonCreditable, carried: settled.carried, offset: settled.offset, payable: settled.payable, credit: settled.credit }
    : {
        output: books.output,
        creditable: books.creditable,
        nonCreditable: books.nonCreditable,
        carried,
        offset,
        payable: round(Math.max(0, books.output - offset)),
        credit: round(available - offset),
      };
  // what keeps the quarter from being settled now
  const blockers: string[] = [];
  if (range.end > new Date()) blockers.push("این فصل هنوز تمام نشده است");
  if (!settled) {
    const first = await firstQuarter(owner);
    if (first && before(first, { year, quarter })) {
      const prev = previous({ year, quarter });
      if (!before(prev, first) && !(await BizVatQuarter.exists({ ...own(owner), year: prev.year, quarter: prev.quarter })))
        blockers.push("ابتدا فصل‌های قبل را ببندید");
    }
  }
  // the books and Moadian should agree on output VAT
  const gap = round(books.output - sales.vat);
  return {
    year,
    quarter,
    ...range,
    ended: range.end <= new Date(),
    sales,
    purchases,
    books: { output: books.output, input: books.input, creditable: books.creditable, nonCreditable: books.nonCreditable },
    unpaidBefore: unpaid,
    figures,
    gap,
    settled: settled ? { settledAt: settled.settledAt, paidAt: settled.paidAt } : null,
    blockers,
  };
};

// the quarters of a year with their state
export const vatYear = async (owner: BizOwner, year: number) => {
  const settled = await BizVatQuarter.find({ ...own(owner), year }).lean<IBizVatQuarter[]>();
  const latest = await BizVatQuarter.findOne(own(owner)).sort({ year: -1, quarter: -1 }).lean<IBizVatQuarter>();
  return [1, 2, 3, 4].map((quarter) => {
    const r = quarterRange(year, quarter);
    const s = settled.find((x) => x.quarter === quarter);
    return {
      quarter,
      ...r,
      ended: r.end <= new Date(),
      settled: !!s,
      payable: s?.payable,
      credit: s?.credit,
      paidAt: s?.paidAt,
      canReopen: !!s && !s.paidAt && latest?.year === year && latest?.quarter === quarter,
    };
  });
};

export const settleQuarter = async (owner: BizOwner, year: number, quarter: number, by?: unknown) => {
  const report = await vatQuarter(owner, year, quarter);
  if (report.settled) throw new AppError("این فصل قبلاً بسته شده است", 400);
  if (report.blockers.length) throw new AppError(report.blockers[0], 400);
  const f = report.figures;
  const seq = (await BizVoucher.countDocuments({ ...ownerFilter(owner), ref: new RegExp(`^vat:${year}-${quarter}:\\d+$`) })) + 1;
  const lines: PostLine[] = [];
  if (f.offset > 0) lines.push({ role: "vatPayable", debit: f.offset }, { role: "vatReceivable", credit: f.offset });
  if (f.nonCreditable > 0) lines.push({ role: "vatNonCreditable", debit: f.nonCreditable }, { role: "vatReceivable", credit: f.nonCreditable });
  const doc = await BizVatQuarter.create({
    ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) }),
    year,
    quarter,
    start: report.start,
    end: report.end,
    ...f,
    seq,
    createdBy: by,
  }).catch((err) => {
    if ((err as { code?: number }).code === 11000) throw new AppError("این فصل قبلاً بسته شده است", 400);
    throw err;
  });
  if (lines.length)
    await postVoucher(owner, {
      ref: REF(year, quarter, seq),
      date: report.end,
      description: "تهاتر مالیات بر ارزش افزوده‌ی فصل",
      source: { type: "vatquarter", id: doc._id },
      lines,
      createdBy: by,
    });
  return doc.toObject();
};

export const payQuarter = async (owner: BizOwner, year: number, quarter: number, via: string, date?: Date) => {
  const q = await BizVatQuarter.findOne({ ...own(owner), year, quarter }).lean<IBizVatQuarter>();
  if (!q) throw new AppError("ابتدا این فصل را ببندید", 400);
  if (q.paidAt) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  if (!(q.payable > 0)) throw new AppError("مالیاتی برای پرداخت در این فصل نیست", 400);
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: via }).lean();
  if (!acc || acc.type !== "asset" || acc.level !== "detail") throw new AppError("پرداخت یا دریافت فقط از صندوق، بانک یا کیف پول ممکن است", 400);
  const claimed = await BizVatQuarter.updateOne({ _id: q._id, paidAt: { $exists: false } }, { $set: { paidAt: date || new Date(), paidVia: acc._id } });
  if (!claimed.modifiedCount) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  await postVoucher(owner, {
    ref: `${REF(year, quarter, q.seq)}:pay`,
    date: date || new Date(),
    description: "پرداخت مالیات بر ارزش افزوده‌ی فصل",
    source: { type: "vatquarter", id: q._id },
    lines: [
      { role: "vatPayable", debit: q.payable },
      { accountId: String(acc._id), credit: q.payable },
    ],
  });
  return BizVatQuarter.findById(q._id).lean();
};

// the latest settled quarter, while unpaid, opens again (its voucher reversed)
export const reopenQuarter = async (owner: BizOwner, year: number, quarter: number) => {
  const latest = await BizVatQuarter.findOne(own(owner)).sort({ year: -1, quarter: -1 }).lean<IBizVatQuarter>();
  if (!latest || latest.year !== year || latest.quarter !== quarter) throw new AppError("فقط آخرین فصل بسته‌شده دوباره باز می‌شود", 400);
  if (latest.paidAt) throw new AppError("برای این فصل پرداخت ثبت شده و برنمی‌گردد", 400);
  const removed = await BizVatQuarter.deleteOne({ _id: latest._id, paidAt: { $exists: false } });
  if (!removed.deletedCount) throw new AppError("این فصل هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const ref = REF(year, quarter, latest.seq);
  const original = await BizVoucher.findOne({ ...ownerFilter(owner), ref }).lean<{ date: Date; lines: { account: unknown; debit: number; credit: number }[] }>();
  if (original?.lines?.length)
    await postVoucher(owner, {
      ref: `${ref}:rev`,
      // on the same day, so the quarter after sees the balances as before
      date: original.date,
      description: "برگشت تهاتر مالیات بر ارزش افزوده",
      lines: original.lines.map((l) => ({ accountId: String(l.account), debit: l.credit, credit: l.debit })),
    });
};
