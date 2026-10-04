import mongoose from "mongoose";
import BizAccount, { BizOwnerKind, IBizAccount } from "../../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizMoneyAccount, { BizMoneyKind, IBizMoneyAccount } from "../../Models/BizMoneyAccount";
import AppError from "../AppError";
import { accountFor, BizOwner, ensureChart, ownerFilter } from "./coa";
import { lockedDate, postVoucher, PostLine } from "./voucher";
import { PartyRef } from "./parties";

// Shared pieces of the practice-finance suite (2026-10, «مالی و حسابداری»
// in every provider panel): invoices, receipts and payments with cheques,
// expenses, insurance claims and their reports. All of it sits on the one
// Noyan Business engine - every write is a balanced voucher through
// postVoucher, every figure is read back from the books - and nothing here
// moves real money (the wallet stays the platform's, docs/business-suite.md
// principle 2).

export const toman = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

export const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));

export const ownerDoc = (owner: BizOwner) => {
  if (owner.kind === "platform" || !owner.id) throw new AppError("این بخش برای این حساب نیست", 400);
  return { ownerKind: owner.kind, ownerId: oid(owner.id) };
};

// the income a provider's own invoice line is booked to when none is chosen
export const defaultIncomeRole = (kind: BizOwnerKind) =>
  kind === "pharmacy" ? "salesIncome" : kind === "paraClinic" ? "testIncome" : kind === "insurance" ? "premiumIncome" : "serviceIncome";

// A document the owner dates (an invoice, an expense, a payment) may not
// land in a closed fiscal year - the same rule as a hand-typed voucher.
export const assertOpen = async (owner: BizOwner, date: Date) => {
  await lockedDate(owner, date, true);
};

// Posts one voucher of a finance document. Written as "auto": it is
// changed only through its document (void, bounce...), never by hand on the
// accounting page.
export const postDoc = async (
  owner: BizOwner,
  d: {
    ref: string;
    date: Date;
    description: string;
    lines: PostLine[];
    source: { type: string; id: unknown };
    center?: unknown;
    createdBy?: unknown;
    // the تفصیلی of its receivable / payable lines (2026-10)
    party?: PartyRef;
  },
) =>
  postVoucher(owner, {
    ref: d.ref,
    date: d.date,
    description: d.description,
    source: d.source,
    lines: d.lines,
    center: d.center,
    createdBy: d.createdBy,
    party: d.party,
  });

// The exact opposite of a posted voucher (a voided invoice, payment or
// expense), dated now; a no-op when there is nothing to reverse or it was
// reversed already.
export const reverseRef = async (owner: BizOwner, ref: string, description: string, date = new Date()) => {
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), ref }).lean<IBizVoucher>();
  if (!v) return null;
  return postVoucher(owner, {
    ref: `${ref}:void`,
    date,
    description,
    source: v.source ? { type: v.source.type, id: v.source.id } : undefined,
    center: v.center,
    lines: v.lines.map((l) => ({ accountId: l.account, party: l.party, center: l.center, label: l.label, debit: l.credit, credit: l.debit })),
  });
};

// every voucher a document wrote, its reversals left out
export const docRefs = async (owner: BizOwner, prefix: string) =>
  (
    await BizVoucher.find({ ...ownerFilter(owner), ref: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:|$)` } })
      .select("ref")
      .lean<{ ref: string }[]>()
  )
    .map((v) => v.ref)
    .filter((r) => !r.endsWith(":void"));

// ------------------------------------------------------- money accounts

const ROLE_KIND: Record<string, BizMoneyKind> = { cash: "cash", bank: "bank", noyanWallet: "wallet" };
// what Noyan holds in settlement and money on its way to the bank are not
// a till or an account the owner pays from
const NOT_MONEY = new Set(["noyanPending", "withdrawalTransit"]);

// Every till and bank account of an owner has its row: the system cash,
// bank and Noyan-wallet accounts, and any account the owner opened under
// «موجودی نقد» on the accounting page.
export const ensureMoneyAccounts = async (owner: BizOwner) => {
  await ensureChart(owner);
  const own = ownerDoc(owner);
  const accounts = await BizAccount.find({ ...ownerFilter(owner), parentCode: "11", level: "detail" }).lean<IBizAccount[]>();
  const have = new Set(
    (await BizMoneyAccount.find(own).select("account").lean<{ account: mongoose.Types.ObjectId }[]>()).map((r) => String(r.account)),
  );
  for (const a of accounts) {
    if (have.has(String(a._id)) || NOT_MONEY.has(a.role || "")) continue;
    await BizMoneyAccount.create({ ...own, account: a._id, kind: ROLE_KIND[a.role || ""] || "bank", name: a.name }).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
  }
};

export const listMoneyAccounts = async (owner: BizOwner) => {
  await ensureMoneyAccounts(owner);
  const rows = await BizMoneyAccount.find(ownerDoc(owner)).sort({ createdAt: 1 }).lean<IBizMoneyAccount[]>();
  const accounts = await BizAccount.find({ _id: { $in: rows.map((r) => r.account) } }).lean<IBizAccount[]>();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const codes = accounts.map((a) => a.code);
  const sums = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $nin: ["final", "open"] } } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $in: codes } } },
    { $group: { _id: "$lines.code", d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  const bal = new Map(sums.map((s) => [s._id as string, (s.d as number) - (s.c as number)]));
  const cleared = await Promise.all(rows.map((r) => clearedBalance(owner, r, byId.get(String(r.account))?.code)));
  return rows
    .filter((r) => byId.has(String(r.account)))
    .map((r, i) => {
      const acc = byId.get(String(r.account))!;
      return {
        _id: r._id,
        kind: r.kind,
        name: r.kind === "cash" || r.kind === "wallet" || acc.role ? acc.name : r.name,
        code: acc.code,
        role: acc.role,
        bankName: r.bankName,
        accountNumber: r.accountNumber,
        sheba: r.sheba,
        isActive: r.isActive,
        balance: Math.round(bal.get(acc.code) || 0),
        cleared: Math.round(cleared[i]),
        statementBalance: r.statementBalance,
        statementDate: r.statementDate,
      };
    });
};

const clearedBalance = async (owner: BizOwner, r: IBizMoneyAccount, code?: string) => {
  if (!code || !r.reconciled?.length) return 0;
  const [row] = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), _id: { $in: r.reconciled } } },
    { $unwind: "$lines" },
    { $match: { "lines.code": code } },
    { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  return (row?.d || 0) - (row?.c || 0);
};

// a new till, bank account or card reader: a detail account under 11 and
// its row
export const createMoneyAccount = async (
  owner: BizOwner,
  d: { kind: Exclude<BizMoneyKind, "wallet">; name: string; bankName?: string; accountNumber?: string; sheba?: string },
) => {
  await ensureChart(owner);
  const own = ownerDoc(owner);
  const used = new Set(
    (await BizAccount.find({ ...ownerFilter(owner), parentCode: "11" }).select("code").lean<{ code: string }[]>()).map((a) => a.code),
  );
  let n = 10;
  while (n < 100 && used.has(`11${String(n).padStart(2, "0")}`)) n++;
  if (n >= 100) throw new AppError("زیر این حساب کل جای حساب تازه نیست", 400);
  const account = await BizAccount.create({
    ...own,
    code: `11${String(n).padStart(2, "0")}`,
    name: d.name,
    type: "asset",
    level: "detail",
    parentCode: "11",
  });
  return BizMoneyAccount.create({ ...own, account: account._id, ...d });
};

export const updateMoneyAccount = async (
  owner: BizOwner,
  id: string,
  d: { name?: string; bankName?: string; accountNumber?: string; sheba?: string; isActive?: boolean },
) => {
  const row = await BizMoneyAccount.findOne({ ...ownerDoc(owner), _id: id });
  if (!row) throw new AppError("حساب پیدا نشد", 404);
  const acc = await BizAccount.findById(row.account);
  if (d.name && acc && !acc.role) {
    acc.name = d.name;
    await acc.save();
    row.name = d.name;
  }
  for (const k of ["bankName", "accountNumber", "sheba"] as const) if (d[k] !== undefined) row[k] = d[k] || undefined;
  if (d.isActive !== undefined && row.kind !== "wallet") row.isActive = d.isActive;
  await row.save();
  return row;
};

// the till / bank a payment uses, checked to be the owner's
export const moneyAccountOf = async (owner: BizOwner, id: unknown) => {
  if (!id || !mongoose.isValidObjectId(String(id))) throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  const row = await BizMoneyAccount.findOne({ ...ownerDoc(owner), _id: id }).lean<IBizMoneyAccount>();
  if (!row) throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  return row;
};

// the money account the Noyan wallet is booked to
export const walletMoneyAccount = async (owner: BizOwner) => {
  await ensureMoneyAccounts(owner);
  const acc = await accountFor(owner, "noyanWallet");
  return BizMoneyAccount.findOne({ ...ownerDoc(owner), account: acc._id }).lean<IBizMoneyAccount>();
};

// One money account's lines, newest first, with whether each matched the
// bank statement (reconciliation).
export const moneyAccountLines = async (owner: BizOwner, id: string, from: Date | null, to: Date | null) => {
  const row = await BizMoneyAccount.findOne({ ...ownerDoc(owner), _id: id }).lean<IBizMoneyAccount>();
  if (!row) throw new AppError("حساب پیدا نشد", 404);
  const acc = await BizAccount.findById(row.account).lean<IBizAccount>();
  if (!acc) throw new AppError("حساب پیدا نشد", 404);
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $nin: ["final", "open"] }, ...(from || to ? { date: range } : {}), "lines.code": acc.code } },
    { $sort: { date: -1, number: -1 } },
    { $limit: 500 },
    { $unwind: "$lines" },
    { $match: { "lines.code": acc.code } },
    { $project: { number: 1, date: 1, description: 1, label: "$lines.label", debit: "$lines.debit", credit: "$lines.credit" } },
  ]);
  const done = new Set((row.reconciled || []).map(String));
  return {
    account: { _id: row._id, name: acc.name, code: acc.code, kind: row.kind, statementBalance: row.statementBalance, statementDate: row.statementDate },
    lines: rows.map((r) => ({ ...r, amount: (r.debit || 0) - (r.credit || 0), reconciled: done.has(String(r._id)) })),
  };
};

export const reconcile = async (
  owner: BizOwner,
  id: string,
  d: { vouchers: string[]; cleared: boolean; statementBalance?: number; statementDate?: Date },
) => {
  const row = await BizMoneyAccount.findOne({ ...ownerDoc(owner), _id: id });
  if (!row) throw new AppError("حساب پیدا نشد", 404);
  const ids = d.vouchers.filter((v) => mongoose.isValidObjectId(v)).map((v) => oid(v));
  const owned = await BizVoucher.find({ ...ownerFilter(owner), _id: { $in: ids } }).select("_id").lean();
  const set = new Set((row.reconciled || []).map(String));
  for (const v of owned) d.cleared ? set.add(String(v._id)) : set.delete(String(v._id));
  row.reconciled = [...set].map((v) => oid(v));
  if (d.statementBalance !== undefined) row.statementBalance = Math.round(d.statementBalance);
  if (d.statementDate) row.statementDate = d.statementDate;
  await row.save();
  return row;
};
