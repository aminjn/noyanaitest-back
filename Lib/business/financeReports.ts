import moment from "moment-jalaali";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher from "../../Models/BizVoucher";
import BizInvoice from "../../Models/BizInvoice";
import BizPayment, { IBizPayment } from "../../Models/BizPayment";
import BizExpense from "../../Models/BizExpense";
import BizClaim from "../../Models/BizClaim";
import Wallet from "../../Models/Wallet";
import { BizOwner, ensureChart, ownerFilter } from "./coa";
import { accountRows, WITHOUT_CLOSING } from "./reports";
import { yearOf, yearRange } from "./fiscalYear";
import { listMoneyAccounts, ownerDoc } from "./finance";
import { syncPlatformInvoices } from "./invoices";
import { pendingSummary } from "../payoutHold";
import { orgInfo } from "./campaign";
import { runRecurring } from "./expenses";
import { remindCheques } from "./payments";

// The practice-finance dashboard and its reports (2026-10, «مالی و
// حسابداری» → نمای کلی / گزارش‌ها), in the Jalali calendar as Tehran sees it:
// income and expense of this month and of the fiscal year so far, cash and
// bank, what patients and insurers owe, what is owed, the cheques falling
// due, the wallet and its next settlement, and twelve months of income
// against expense. Every figure comes from the books.

const TEHRAN = 210;
const jMonthStart = (m: moment.Moment) => m.clone().utcOffset(TEHRAN).startOf("jMonth").toDate();

// income and expense per Jalali month from `start`, one aggregation
const monthly = async (owner: BizOwner, start: Date, months: number) => {
  const accounts = await BizAccount.find({ ...ownerFilter(owner), type: { $in: ["income", "expense"] }, level: "detail" })
    .select("code type")
    .lean<IBizAccount[]>();
  const typeOf = new Map(accounts.map((a) => [a.code, a.type]));
  const rows = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), date: { $gte: start }, phase: { $nin: WITHOUT_CLOSING } } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $in: [...typeOf.keys()] } } },
    {
      $group: {
        _id: { code: "$lines.code", day: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: "+03:30" } } },
        d: { $sum: "$lines.debit" },
        c: { $sum: "$lines.credit" },
      },
    },
  ]);
  const base = moment(start).utcOffset(TEHRAN);
  const out = Array.from({ length: months }, (_, i) => {
    const m = base.clone().add(i, "jMonth");
    return { month: m.toDate(), label: `${m.jYear()}/${String(m.jMonth() + 1).padStart(2, "0")}`, income: 0, expense: 0 };
  });
  for (const r of rows) {
    const m = moment(`${r._id.day}T12:00:00+03:30`).utcOffset(TEHRAN);
    const idx = (m.jYear() - base.jYear()) * 12 + (m.jMonth() - base.jMonth());
    if (idx < 0 || idx >= months) continue;
    if (typeOf.get(r._id.code) === "income") out[idx].income += r.c - r.d;
    else out[idx].expense += r.d - r.c;
  }
  return out.map((o) => ({ ...o, income: Math.round(o.income), expense: Math.round(o.expense) }));
};

export const financeOverview = async (owner: BizOwner) => {
  await ensureChart(owner);
  await syncPlatformInvoices(owner).catch(() => undefined);
  const now = moment().utcOffset(TEHRAN);
  const monthStart = jMonthStart(now);
  const { start: yearStart } = yearRange(yearOf(new Date()));
  const seriesStart = jMonthStart(now.clone().subtract(11, "jMonth"));
  const own = ownerDoc(owner);
  const [rows, money, series, cheques, openInvoices, unpaidExpenses, openClaims, info] = await Promise.all([
    accountRows(owner, monthStart, null, WITHOUT_CLOSING),
    listMoneyAccounts(owner),
    monthly(owner, seriesStart, 12),
    BizPayment.find({ ...own, method: "cheque", isVoid: false, "cheque.status": { $in: ["pending", "bounced"] } })
      .sort({ "cheque.dueDate": 1 })
      .limit(200)
      .select("direction amount party cheque.number cheque.bank cheque.dueDate cheque.status")
      .lean<IBizPayment[]>(),
    BizInvoice.aggregate([
      { $match: { ...own, status: { $in: ["issued", "partial"] } } },
      { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $subtract: ["$patientShare", "$paid"] } } } },
    ]),
    BizExpense.aggregate([
      { $match: { ...own, isVoid: false, recurring: { $exists: false }, $expr: { $lt: ["$paid", "$total"] } } },
      { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $subtract: ["$total", "$paid"] } } } },
    ]),
    BizClaim.aggregate([
      { $match: { ...own, status: { $in: ["submitted", "partial"] } } },
      { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $subtract: [{ $subtract: ["$claimed", "$paid"] }, "$deducted"] } } } },
    ]),
    orgInfo(owner).catch(() => null),
  ]);
  const details = rows.filter((r) => r.level === "detail");
  const role = (r: string) => details.find((d) => d.role === r)?.balance || 0;
  const monthIncome = details.filter((r) => r.type === "income").reduce((s, r) => s + r.period, 0);
  const monthExpense = details.filter((r) => r.type === "expense").reduce((s, r) => s + r.period, 0);
  // the fiscal year so far: the series covers it when it began within the
  // last twelve months, else one more statement
  const ytd = series.filter((m) => m.month >= yearStart);
  const yearIncome = ytd.reduce((s, m) => s + m.income, 0);
  const yearExpense = ytd.reduce((s, m) => s + m.expense, 0);
  const [wallet, hold] = await Promise.all([
    info?.user ? Wallet.findOne({ user: info.user }).select("balance pending").lean<{ balance?: number; pending?: number }>() : null,
    info?.user ? pendingSummary(info.user) : null,
  ]);
  const horizon = Date.now() + 30 * 864e5;
  return {
    month: { start: monthStart, income: Math.round(monthIncome), expense: Math.round(monthExpense), profit: Math.round(monthIncome - monthExpense) },
    year: { year: yearOf(new Date()), start: yearStart, income: yearIncome, expense: yearExpense, profit: yearIncome - yearExpense },
    money: money.filter((m) => m.isActive),
    cash: money.filter((m) => m.kind === "cash").reduce((s, m) => s + m.balance, 0),
    bank: money.filter((m) => m.kind === "bank" || m.kind === "pos").reduce((s, m) => s + m.balance, 0),
    receivables: {
      patients: Math.round(role("receivable")),
      insurers: Math.round(role("insuranceReceivable")),
      cheques: Math.round(role("chequesReceivable")),
    },
    payables: {
      vendors: Math.round(role("payable")),
      cheques: Math.round(role("chequesPayable")),
      salaries: Math.round(role("salaryPayable") + role("payrollTaxPayable")),
      vat: Math.round(role("vatPayable")),
    },
    cheques: {
      upcoming: cheques.filter((c) => c.cheque?.status === "pending" && new Date(c.cheque.dueDate).getTime() <= horizon).slice(0, 8),
      overdue: cheques.filter((c) => c.cheque?.status === "pending" && new Date(c.cheque.dueDate).getTime() < Date.now()).length,
      bounced: cheques.filter((c) => c.cheque?.status === "bounced").length,
    },
    wallet: {
      balance: Math.round(wallet?.balance || 0),
      pending: Math.round(hold?.pending ?? wallet?.pending ?? 0),
      nextReleaseAt: hold?.nextReleaseAt || null,
      holdDays: hold?.holdDays ?? null,
    },
    open: {
      invoices: { count: openInvoices[0]?.n || 0, amount: Math.round(openInvoices[0]?.due || 0) },
      expenses: { count: unpaidExpenses[0]?.n || 0, amount: Math.round(unpaidExpenses[0]?.due || 0) },
      claims: { count: openClaims[0]?.n || 0, amount: Math.round(openClaims[0]?.due || 0) },
    },
    series,
  };
};

// Income by service, by doctor and by insurer over a period, from the
// invoices (platform and typed) - Practo Ray's "collections by" reports.
export const incomeBreakdown = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  await syncPlatformInvoices(owner).catch(() => undefined);
  const match: Record<string, unknown> = { ...ownerDoc(owner), status: { $nin: ["draft", "void"] } };
  if (from || to) match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [byService, byDoctor, byInsurer, bySource, totals] = await Promise.all([
    BizInvoice.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $group: { _id: "$lines.title", count: { $sum: "$lines.qty" }, net: { $sum: "$lines.net" }, tax: { $sum: "$lines.tax" } } },
      { $sort: { net: -1 } },
      { $limit: 50 },
    ]),
    BizInvoice.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ["$doctorName", ""] }, count: { $sum: 1 }, total: { $sum: "$total" }, paid: { $sum: "$paid" } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]),
    BizInvoice.aggregate([
      { $match: { ...match, "insurer.share": { $gt: 0 } } },
      { $group: { _id: { kind: "$insurer.kind", name: "$insurer.name" }, count: { $sum: 1 }, share: { $sum: "$insurer.share" }, total: { $sum: "$total" } } },
      { $sort: { share: -1 } },
    ]),
    BizInvoice.aggregate([{ $match: match }, { $group: { _id: "$origin", count: { $sum: 1 }, total: { $sum: "$total" } } }]),
    BizInvoice.aggregate([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" }, tax: { $sum: "$tax" }, discount: { $sum: "$discount" }, insurer: { $sum: { $ifNull: ["$insurer.share", 0] } } } },
    ]),
  ]);
  return {
    byService: byService.map((r) => ({ title: r._id, count: r.count, net: r.net, tax: r.tax })),
    byDoctor: byDoctor.map((r) => ({ name: r._id, count: r.count, total: r.total, paid: r.paid })),
    byInsurer: byInsurer.map((r) => ({ kind: r._id.kind, name: r._id.name, count: r.count, share: r.share, total: r.total })),
    bySource: bySource.map((r) => ({ origin: r._id, count: r.count, total: r.total })),
    totals: totals[0] || { count: 0, total: 0, tax: 0, discount: 0, insurer: 0 },
  };
};

// What patients and insurers owe, by age: 0-30, 31-60, 61-90, 90+ days
// (patients from the invoice date, insurers from the claim's submission or,
// not yet claimed, the invoice date).
export const agingReport = async (owner: BizOwner) => {
  const own = ownerDoc(owner);
  const now = Date.now();
  const bucket = (d: Date | undefined) => {
    const days = d ? (now - new Date(d).getTime()) / 864e5 : 0;
    return days <= 30 ? "d30" : days <= 60 ? "d60" : days <= 90 ? "d90" : "older";
  };
  const empty = () => ({ d30: 0, d60: 0, d90: 0, older: 0, total: 0 });
  const invoices = await BizInvoice.find({ ...own, origin: "manual", status: { $in: ["issued", "partial", "paid"] } })
    .select("number date dueDate party patientShare paid insurer claim")
    .lean();
  const patients = new Map<string, ReturnType<typeof empty> & { name: string; phone?: string; count: number }>();
  const insurers = new Map<string, ReturnType<typeof empty> & { name: string; kind: string }>();
  for (const inv of invoices) {
    const due = (inv.patientShare || 0) - (inv.paid || 0);
    if (due > 0.5) {
      const key = `${inv.party?.name || ""}|${inv.party?.phone || ""}`;
      const row = patients.get(key) || { ...empty(), name: inv.party?.name || "", phone: inv.party?.phone, count: 0 };
      row[bucket(inv.date)] += due;
      row.total += due;
      row.count++;
      patients.set(key, row);
    }
    if ((inv.insurer?.share || 0) > 0 && !inv.claim) {
      const key = `${inv.insurer!.kind}|${inv.insurer!.name}`;
      const row = insurers.get(key) || { ...empty(), name: inv.insurer!.name, kind: inv.insurer!.kind };
      row[bucket(inv.date)] += inv.insurer!.share;
      row.total += inv.insurer!.share;
      insurers.set(key, row);
    }
  }
  const claims = await BizClaim.find({ ...own, status: { $in: ["submitted", "partial"] } }).select("insurer claimed paid deducted submittedAt").lean();
  for (const c of claims) {
    const due = c.claimed - c.paid - c.deducted;
    if (due <= 0.5) continue;
    const key = `${c.insurer.kind}|${c.insurer.name}`;
    const row = insurers.get(key) || { ...empty(), name: c.insurer.name, kind: c.insurer.kind };
    row[bucket(c.submittedAt)] += due;
    row.total += due;
    insurers.set(key, row);
  }
  const sort = <T extends { total: number }>(m: Map<string, T>) => [...m.values()].sort((a, b) => b.total - a.total);
  const sum = (list: ReturnType<typeof empty>[]) =>
    list.reduce((s, r) => ({ d30: s.d30 + r.d30, d60: s.d60 + r.d60, d90: s.d90 + r.d90, older: s.older + r.older, total: s.total + r.total }), empty());
  const p = sort(patients);
  const i = sort(insurers);
  return { patients: p.slice(0, 300), insurers: i, patientTotals: sum(p), insurerTotals: sum(i) };
};

// The suite's daily work: due recurring expenses written, cheques falling
// due within three days announced to their owner.
export const startFinanceJob = (intervalMs = 6 * 60 * 60 * 1000) => {
  const run = async () => {
    await runRecurring().catch((err) => console.log("[finance] recurring expenses failed:", err));
    await remindCheques().catch((err) => console.log("[finance] cheque reminders failed:", err));
  };
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};
