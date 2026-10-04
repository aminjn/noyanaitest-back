import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizCostCenter, { IBizCostCenter } from "../../Models/BizCostCenter";
import BizBudget, { IBizBudget } from "../../Models/BizBudget";
import AppError from "../AppError";
import { BizOwner, ensureChart, natural, ownerFilter } from "./coa";
import { accountRows, WITHOUT_CLOSING } from "./reports";
import { yearRange } from "./fiscalYear";

// The further statements of Noyan Business (2026-10, docs/business-suite.md
// phase 6): where cash came from and went (direct method), income and
// expense by cost centre, and a year's budget against what happened.

const NO_TRANSFER = { phase: { $nin: ["pl", "final", "open"] } };
const round = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------ cash flow

// cash: the till, the banks, the Noyan wallet and money on its way to the
// bank - every detail account under «موجودی نقد» except what Noyan still
// holds in settlement
const cashCodesOf = (accounts: IBizAccount[]) =>
  new Set(accounts.filter((a) => a.level === "detail" && a.parentCode === "11" && a.role !== "noyanPending").map((a) => a.code));

type Flow = "operating" | "investing" | "financing";

// what a voucher's cash movement was for, from its other lines: a fixed
// asset makes it investing, the owner's capital or drawings financing
const flowOf = (others: { code: string; type: string; role?: string }[]): Flow => {
  if (others.some((l) => l.code.startsWith("25"))) return "investing";
  if (others.some((l) => l.type === "equity" && l.role !== "retainedEarnings")) return "financing";
  return "operating";
};

export const cashFlow = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  await ensureChart(owner);
  const accounts = await BizAccount.find(ownerFilter(owner)).lean<IBizAccount[]>();
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const cash = cashCodesOf(accounts);
  const cashBalance = async (before: Date | null, inclusive: boolean) => {
    if (!before) return 0;
    const rows = await BizVoucher.aggregate([
      { $match: { ...ownerFilter(owner), ...NO_TRANSFER, date: inclusive ? { $lte: before } : { $lt: before } } },
      { $unwind: "$lines" },
      { $match: { "lines.code": { $in: [...cash] } } },
      { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
    ]);
    return round((rows[0]?.d || 0) - (rows[0]?.c || 0));
  };
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const vouchers = await BizVoucher.find({
    ...ownerFilter(owner),
    ...NO_TRANSFER,
    ...(from || to ? { date: range } : {}),
    "lines.code": { $in: [...cash] },
  })
    .select("lines")
    .lean<IBizVoucher[]>();
  const sections: Record<Flow, Map<string, number>> = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const v of vouchers) {
    const delta = v.lines.filter((l) => cash.has(l.code)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (Math.abs(delta) < 0.005) continue; // a transfer between cash accounts
    const others = v.lines
      .filter((l) => !cash.has(l.code))
      .map((l) => ({ ...l, type: byCode.get(l.code)?.type || "asset", role: byCode.get(l.code)?.role }));
    // a balanced voucher's cash change is exactly what its other lines
    // give: each one's credit less its debit (a sale +, its fee -)
    const flow = flowOf(others);
    for (const l of others) sections[flow].set(l.code, (sections[flow].get(l.code) || 0) + l.credit - l.debit);
  }
  const opening = await cashBalance(from, false);
  const closing = to ? await cashBalance(to, true) : await cashBalance(new Date(8.64e15), true);
  const out = (Object.keys(sections) as Flow[]).map((key) => {
    const rows = [...sections[key].entries()]
      .map(([code, amount]) => ({ code, name: byCode.get(code)?.name || code, role: byCode.get(code)?.role, amount: round(amount) }))
      .filter((r) => Math.abs(r.amount) >= 0.5)
      .sort((a, b) => b.amount - a.amount);
    const inflow = round(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
    const outflow = round(rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
    return { key, rows, inflow, outflow, net: round(inflow - outflow) };
  });
  const net = round(out.reduce((s, x) => s + x.net, 0));
  return { opening, closing, net, sections: out, balanced: Math.abs(opening + net - closing) < 1 };
};

// ---------------------------------------------------------- cost centres

export const listCenters = (owner: BizOwner) =>
  BizCostCenter.find(ownerFilter(owner)).sort({ isActive: -1, name: 1 }).lean<IBizCostCenter[]>();

export const createCenter = async (owner: BizOwner, name: string) => {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 2) throw new AppError("نام مرکز هزینه را وارد کنید", 400);
  const existing = await BizCostCenter.findOne({ ...ownerFilter(owner), name: clean }).lean<IBizCostCenter>();
  if (existing) return existing;
  const doc = await BizCostCenter.create({
    ...(owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: owner.id }),
    name: clean,
  });
  return doc.toObject() as IBizCostCenter;
};

export const ownCenter = async (owner: BizOwner, id: unknown) => {
  if (!id) return null;
  const c = await BizCostCenter.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizCostCenter>().catch(() => null);
  if (!c) throw new AppError("مرکز هزینه پیدا نشد", 400);
  return c;
};

// income and expense of every cost centre, and of what was booked to none
export const costCenterReport = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  await ensureChart(owner);
  const accounts = await BizAccount.find(ownerFilter(owner)).select("code type").lean<IBizAccount[]>();
  const type = new Map(accounts.map((a) => [a.code, a.type]));
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await BizVoucher.aggregate<{ _id: { center: unknown; code: string }; d: number; c: number }>([
    { $match: { ...ownerFilter(owner), phase: { $exists: false }, ...(from || to ? { date: range } : {}) } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $regex: "^[67]" } } },
    { $group: { _id: { center: { $ifNull: ["$lines.center", "$center"] }, code: "$lines.code" }, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  const centers = await listCenters(owner);
  const acc = new Map<string, { income: number; expense: number }>();
  for (const r of rows) {
    const key = r._id.center ? String(r._id.center) : "";
    const t = type.get(r._id.code);
    const cur = acc.get(key) || { income: 0, expense: 0 };
    if (t === "income") cur.income += natural("income", r.d, r.c);
    else if (t === "expense") cur.expense += natural("expense", r.d, r.c);
    acc.set(key, cur);
  }
  const list = [
    ...centers.map((c) => ({ _id: String(c._id), name: c.name, isActive: c.isActive, ...(acc.get(String(c._id)) || { income: 0, expense: 0 }) })),
    { _id: "", name: "", isActive: true, ...(acc.get("") || { income: 0, expense: 0 }) },
  ].map((r) => ({ ...r, income: round(r.income), expense: round(r.expense), net: round(r.income - r.expense) }));
  return { rows: list };
};

// ---------------------------------------------------------------- budget

// how much of a Jalali year has gone by, in months (0 to 12, fractional)
const monthsElapsed = (year: number) => {
  const { start, end } = yearRange(year);
  const now = Date.now();
  if (now <= start.getTime()) return 0;
  if (now > end.getTime()) return 12;
  return Math.round(((now - start.getTime()) / (end.getTime() - start.getTime())) * 1200) / 100;
};

export const budgetReport = async (owner: BizOwner, year: number) => {
  await ensureChart(owner);
  const { start, end } = yearRange(year);
  const [budget, rows] = await Promise.all([
    BizBudget.findOne({ ...ownerFilter(owner), year }).lean<IBizBudget>(),
    accountRows(owner, start, end, WITHOUT_CLOSING),
  ]);
  const months = monthsElapsed(year);
  const planned = new Map((budget?.lines || []).map((l) => [l.code, l.amount]));
  const lines = rows
    .filter((r) => r.level === "detail" && (r.type === "income" || r.type === "expense"))
    .map((r) => {
      const amount = planned.get(r.code) || 0;
      const toDate = round((amount * months) / 12);
      return {
        _id: String(r._id),
        code: r.code,
        name: r.name,
        role: r.role,
        type: r.type,
        budget: amount,
        budgetToDate: toDate,
        actual: round(r.period),
        // income above plan and expense below it are good news
        variance: round(r.type === "income" ? r.period - toDate : toDate - r.period),
      };
    });
  const sum = (type: string, k: "budget" | "budgetToDate" | "actual") =>
    round(lines.filter((l) => l.type === type).reduce((s, l) => s + l[k], 0));
  return {
    year,
    months,
    lines,
    totals: {
      income: { budget: sum("income", "budget"), budgetToDate: sum("income", "budgetToDate"), actual: sum("income", "actual") },
      expense: { budget: sum("expense", "budget"), budgetToDate: sum("expense", "budgetToDate"), actual: sum("expense", "actual") },
    },
  };
};

export const saveBudget = async (owner: BizOwner, year: number, input: { account: string; amount: number }[]) => {
  const accounts = await BizAccount.find({ ...ownerFilter(owner), _id: { $in: input.map((l) => l.account) } })
    .select("code type level")
    .lean<IBizAccount[]>();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const lines = [];
  for (const l of input) {
    const a = byId.get(String(l.account));
    if (!a || a.level !== "detail" || (a.type !== "income" && a.type !== "expense"))
      throw new AppError("بودجه فقط برای حساب‌های معین درآمد و هزینه است", 400);
    if (l.amount > 0) lines.push({ account: a._id, code: a.code, amount: round(l.amount) });
  }
  await BizBudget.updateOne(
    { ...ownerFilter(owner), year },
    { $set: { lines } },
    { upsert: true },
  );
};
