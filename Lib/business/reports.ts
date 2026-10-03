import mongoose from "mongoose";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher from "../../Models/BizVoucher";
import { BizOwner, ensureChart, natural, ownerFilter } from "./coa";

// Statements over one owner's books (2026-10), after nexxacrm's
// lib/financial-statements.ts: every figure is summed from voucher lines,
// group and total accounts roll up their children, and the balance sheet
// always balances (assets = liabilities + equity + the profit not yet
// closed into retained earnings).

// Which year-end vouchers a report leaves out (Models/BizVoucher.ts): the
// اختتامیه and افتتاحیه cancel across the year boundary and would zero a
// balance sheet dated on the last day; the income statement also leaves out
// the closing of income and expense, or a closed year would show no profit.
export type Phase = "pl" | "final" | "open";
export const WITHOUT_TRANSFER: Phase[] = ["final", "open"];
export const WITHOUT_CLOSING: Phase[] = ["pl", "final", "open"];
const phaseMatch = (exclude: Phase[]) => (exclude.length ? { phase: { $nin: exclude } } : {});

type Sums = { bD: number; bC: number; pD: number; pC: number };
export type Row = Pick<IBizAccount, "_id" | "code" | "name" | "type" | "level" | "parentCode" | "role"> &
  Sums & { before: number; period: number; balance: number };

const sumLines = async (owner: BizOwner, match: Record<string, unknown>, exclude: Phase[]) => {
  const rows = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), ...match, ...phaseMatch(exclude) } },
    { $unwind: "$lines" },
    { $group: { _id: "$lines.code", d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  return new Map<string, { d: number; c: number }>(rows.map((r) => [r._id, { d: r.d, c: r.c }]));
};

// Every account with its turnover before `from` and within [from, to],
// group and total rows included (rolled up from their children).
export const accountRows = async (
  owner: BizOwner,
  from: Date | null,
  to: Date | null,
  exclude: Phase[] = WITHOUT_TRANSFER,
): Promise<Row[]> => {
  await ensureChart(owner);
  const accounts = await BizAccount.find(ownerFilter(owner)).sort({ code: 1 }).lean<IBizAccount[]>();
  const end = to ? { $lte: to } : undefined;
  const [before, period] = await Promise.all([
    from ? sumLines(owner, { date: { $lt: from } }, exclude) : Promise.resolve(new Map()),
    sumLines(owner, from || end ? { date: { ...(from ? { $gte: from } : {}), ...(end || {}) } } : {}, exclude),
  ]);
  const byCode = new Map<string, Row>();
  for (const a of accounts) {
    const b = before.get(a.code) || { d: 0, c: 0 };
    const p = period.get(a.code) || { d: 0, c: 0 };
    byCode.set(a.code, { ...a, bD: b.d, bC: b.c, pD: p.d, pC: p.c, before: 0, period: 0, balance: 0 });
  }
  // roll detail sums up to their total and group, deepest first
  const ordered = [...byCode.values()].sort((x, y) => y.code.length - x.code.length);
  for (const r of ordered) {
    if (!r.parentCode) continue;
    const parent = byCode.get(r.parentCode);
    if (!parent) continue;
    parent.bD += r.bD;
    parent.bC += r.bC;
    parent.pD += r.pD;
    parent.pC += r.pC;
  }
  for (const r of byCode.values()) {
    r.before = natural(r.type, r.bD, r.bC);
    r.period = natural(r.type, r.pD, r.pC);
    r.balance = natural(r.type, r.bD + r.pD, r.bC + r.pC);
  }
  return [...byCode.values()].sort((x, y) => (x.code < y.code ? -1 : 1));
};

export const trialBalance = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  const rows = await accountRows(owner, from, to);
  const details = rows.filter((r) => r.level === "detail");
  const totals = details.reduce(
    (s, r) => ({ debit: s.debit + r.pD, credit: s.credit + r.pC }),
    { debit: 0, credit: 0 },
  );
  return { rows, totals, balanced: Math.abs(totals.debit - totals.credit) < 0.5 };
};

export const incomeStatement = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  const rows = (await accountRows(owner, from, to, WITHOUT_CLOSING)).filter((r) => r.level === "detail");
  const income = rows.filter((r) => r.type === "income" && r.period !== 0);
  const expenses = rows.filter((r) => r.type === "expense" && r.period !== 0);
  const totalIncome = income.reduce((s, r) => s + r.period, 0);
  const totalExpense = expenses.reduce((s, r) => s + r.period, 0);
  return { income, expenses, totalIncome, totalExpense, net: totalIncome - totalExpense };
};

export const balanceSheet = async (owner: BizOwner, to: Date | null) => {
  const rows = (await accountRows(owner, null, to)).filter((r) => r.level === "detail");
  const pick = (type: string) => rows.filter((r) => r.type === type && r.balance !== 0);
  const assets = pick("asset");
  const liabilities = pick("liability");
  const equity = pick("equity");
  const sum = (list: Row[]) => list.reduce((s, r) => s + r.balance, 0);
  const profit =
    sum(rows.filter((r) => r.type === "income")) - sum(rows.filter((r) => r.type === "expense"));
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + profit;
  return {
    assets,
    liabilities,
    equity,
    profit,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.5,
  };
};

// One account's lines with a running balance.
export const ledger = async (
  owner: BizOwner,
  accountId: string,
  from: Date | null,
  to: Date | null,
  page: number,
  limit: number,
) => {
  const account = await BizAccount.findOne({ ...ownerFilter(owner), _id: accountId }).lean<IBizAccount>();
  if (!account) return null;
  const codes =
    account.level === "detail"
      ? [account.code]
      : (await BizAccount.find({ ...ownerFilter(owner), code: { $regex: `^${account.code}` }, level: "detail" })
          .select("code")
          .lean()).map((a) => a.code);
  const dateMatch = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const opening = from
    ? (
        await BizVoucher.aggregate([
          { $match: { ...ownerFilter(owner), date: { $lt: from }, ...phaseMatch(WITHOUT_TRANSFER) } },
          { $unwind: "$lines" },
          { $match: { "lines.code": { $in: codes } } },
          { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
        ])
      )[0]
    : null;
  const base = [
    { $match: { ...ownerFilter(owner), ...(from || to ? { date: dateMatch } : {}), ...phaseMatch(WITHOUT_TRANSFER) } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $in: codes } } },
  ];
  const [all, total] = await Promise.all([
    BizVoucher.aggregate([
      ...base,
      { $sort: { date: 1, number: 1 } },
      {
        $project: {
          number: 1,
          date: 1,
          description: 1,
          kind: 1,
          source: 1,
          label: "$lines.label",
          code: "$lines.code",
          debit: "$lines.debit",
          credit: "$lines.credit",
        },
      },
    ]),
    BizVoucher.aggregate([...base, { $count: "n" }]),
  ]);
  let running = natural(account.type, opening?.d || 0, opening?.c || 0);
  const withBalance = all.map((l) => {
    running += natural(account.type, l.debit, l.credit);
    return { ...l, balance: running };
  });
  // newest first, paged
  const items = withBalance.reverse().slice((page - 1) * limit, page * limit);
  return {
    account,
    opening: natural(account.type, opening?.d || 0, opening?.c || 0),
    closing: running,
    items,
    total: total[0]?.n || 0,
  };
};

// The home tiles of the accounting page.
export const summary = async (owner: BizOwner, months = 6) => {
  const now = new Date();
  const monthStarts = Array.from({ length: months + 1 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - months + 1 + i, 1));
  const rows = await accountRows(owner, monthStarts[months - 1], null, WITHOUT_CLOSING);
  const byRole = (role: string) => rows.find((r) => r.role === role)?.balance || 0;
  const details = rows.filter((r) => r.level === "detail");
  const monthIncome = details.filter((r) => r.type === "income").reduce((s, r) => s + r.period, 0);
  const monthExpense = details.filter((r) => r.type === "expense").reduce((s, r) => s + r.period, 0);
  const series = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), date: { $gte: monthStarts[0] }, ...phaseMatch(WITHOUT_CLOSING) } },
    { $unwind: "$lines" },
    {
      $lookup: {
        from: BizAccount.collection.name,
        let: { code: "$lines.code" },
        pipeline: [
          { $match: { $expr: { $eq: ["$code", "$$code"] }, ...ownerFilter(owner) } },
          { $project: { type: 1 } },
        ],
        as: "acc",
      },
    },
    { $unwind: "$acc" },
    { $match: { "acc.type": { $in: ["income", "expense"] } } },
    {
      $group: {
        _id: { y: { $year: "$date" }, m: { $month: "$date" }, t: "$acc.type" },
        d: { $sum: "$lines.debit" },
        c: { $sum: "$lines.credit" },
      },
    },
  ]);
  const monthsOut = monthStarts.slice(0, months).map((start) => {
    const y = start.getFullYear();
    const m = start.getMonth() + 1;
    const of = (t: string) => series.find((s) => s._id.y === y && s._id.m === m && s._id.t === t);
    const inc = of("income");
    const exp = of("expense");
    return {
      month: start,
      income: inc ? inc.c - inc.d : 0,
      expense: exp ? exp.d - exp.c : 0,
    };
  });
  return {
    cash: byRole("cash") + byRole("bank"),
    noyanWallet: byRole("noyanWallet"),
    noyanPending: byRole("noyanPending"),
    receivable: byRole("receivable") + byRole("insuranceReceivable"),
    payable: byRole("payable"),
    monthIncome,
    monthExpense,
    monthProfit: monthIncome - monthExpense,
    months: monthsOut,
  };
};

export const asObjectId = (id: unknown) =>
  mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
