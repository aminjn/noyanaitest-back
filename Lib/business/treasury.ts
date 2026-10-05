import crypto from "crypto";
import mongoose from "mongoose";
import BizMoneyAccount, { IBizMoneyAccount } from "../../Models/BizMoneyAccount";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizPayment, { IBizPayment } from "../../Models/BizPayment";
import Notification from "../../Models/Notification";
import { BizAccSettings, BizBankLine, BizCheckbook, BizTrustCheque, IBizAccSettings, IBizBankLine, IBizCheckbook, IBizTrustCheque } from "../../Models/BizTreasury";
import AppError from "../AppError";
import { accountFor, BizOwner, ensureChart, ownerFilter } from "./coa";
import { nextDocNumber, postVoucher, PostLine } from "./voucher";
import { matchStatement, negativeCheck } from "./accCore";
import { chequeMoveRef, chequeMoveVoucher, createMoneyAccount, ensureMoneyAccounts } from "./finance";
import { resolveParty } from "./parties";
import { syncDoc } from "./payments";
import { orgInfo } from "./campaign";
import { sheetRows } from "./purchaseInvoices";
import moment from "moment-jalaali";

// Treasury (خزانه‌داری, 2026-10), a port of Nexxa's treasury-actions and
// pages (treasury, treasury-ledger, remittances / fund transfers, checks,
// checkbooks, trust checks, bank-rec with statement import, petty cash)
// onto the Noyan money accounts: every till, bank, card reader, petty fund
// and the Noyan wallet is one detail account under «موجودی نقد» (11), so a
// transfer is two lines on two of them and the treasury ledger is that
// account's own ledger. Nexxa's negative-balance policy (allow / warn /
// block) guards every credit to a till or bank.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };
const money = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

// ------------------------------------------------------------ settings

export const getSettings = async (owner: BizOwner): Promise<IBizAccSettings> => {
  const s = await BizAccSettings.findOne(ownerFilter(owner)).lean<IBizAccSettings>();
  return s || ({ negativeTreasury: "warn", matchDays: 5 } as IBizAccSettings);
};

export const saveSettings = async (owner: BizOwner, d: { negativeTreasury?: string; matchDays?: number }) => {
  const set: Record<string, unknown> = {};
  if (d.negativeTreasury && ["allow", "warn", "block"].includes(d.negativeTreasury)) set.negativeTreasury = d.negativeTreasury;
  if (d.matchDays !== undefined) set.matchDays = Math.max(0, Math.min(60, Math.round(Number(d.matchDays) || 0)));
  return BizAccSettings.findOneAndUpdate(ownerFilter(owner), { $set: set, $setOnInsert: ownerFields(owner) }, { upsert: true, new: true }).lean();
};

// ----------------------------------------------------- money accounts

// the detail account of a till / bank the owner picked, or the till
const moneyAccountRow = async (owner: BizOwner, id?: unknown): Promise<{ account: mongoose.Types.ObjectId; name: string; row?: IBizMoneyAccount }> => {
  if (id && mongoose.isValidObjectId(String(id)) && owner.kind !== "platform") {
    const row = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizMoneyAccount>();
    if (row) {
      if (row.isActive === false) throw new AppError("این صندوق یا حساب بانکی غیرفعال است", 400);
      return { account: row.account, name: row.name, row };
    }
  }
  if (id && mongoose.isValidObjectId(String(id))) {
    // the platform has no money rows: a detail account under 11 itself
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: id, parentCode: "11", level: "detail" }).lean<IBizAccount>();
    if (acc) return { account: acc._id, name: acc.name };
    throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  }
  const cash = await accountFor(owner, "cash");
  return { account: cash._id, name: cash.name };
};

const balanceOf = async (owner: BizOwner, accountId: mongoose.Types.ObjectId) => {
  const [r] = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $nin: ["final", "open"] }, "lines.account": accountId } },
    { $unwind: "$lines" },
    { $match: { "lines.account": accountId } },
    { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  return (r?.d || 0) - (r?.c || 0);
};

// Nexxa enforceTreasuryNegative: a credit that would take the till or bank
// below zero is refused (block), warned about (warn) or let through (allow)
export const enforceNegative = async (owner: BizOwner, accountId: mongoose.Types.ObjectId, name: string, amount: number, purpose: string) => {
  if (amount <= 0) return;
  const { negativeTreasury } = await getSettings(owner);
  if (negativeTreasury === "allow") return;
  const balance = await balanceOf(owner, accountId);
  const verdict = negativeCheck(negativeTreasury, balance, amount);
  if (verdict === "block") throw new AppError("موجودی «${1}» برای این پرداخت کافی نیست".replace("${1}", name), 400);
  if (verdict === "warn" && owner.kind !== "platform") {
    const info = await orgInfo(owner).catch(() => null);
    if (info?.user)
      await Notification.create({
        user: info.user,
        source: "System",
        title: "موجودی منفی صندوق یا بانک",
        message: `پس از «${purpose}» موجودی «${name}» منفی شد.`,
      }).catch(() => undefined);
  }
};

// the credit line of a payment out of a till / bank, the policy applied
export const treasuryCredit = async (owner: BizOwner, id: unknown, amount: number, purpose: string, skipCheck = false): Promise<PostLine> => {
  const m = await moneyAccountRow(owner, id);
  if (!skipCheck) await enforceNegative(owner, m.account, m.name, amount, purpose);
  return { accountId: m.account, credit: amount };
};

export const listTreasury = async (owner: BizOwner) => {
  if (owner.kind === "platform") {
    await ensureChart(owner);
    const accs = await BizAccount.find({ ...ownerFilter(owner), parentCode: "11", level: "detail" }).sort({ code: 1 }).lean<IBizAccount[]>();
    return Promise.all(accs.map(async (a) => ({ _id: a._id, account: a._id, kind: a.role === "cash" ? "cash" : "bank", name: a.name, code: a.code, isActive: true, balance: Math.round(await balanceOf(owner, a._id)) })));
  }
  await ensureMoneyAccounts(owner);
  const rows = await BizMoneyAccount.find(ownerFilter(owner)).sort({ createdAt: 1 }).lean<IBizMoneyAccount[]>();
  const accs = new Map((await BizAccount.find({ _id: { $in: rows.map((r) => r.account) } }).lean<IBizAccount[]>()).map((a) => [String(a._id), a]));
  return Promise.all(
    rows
      .filter((r) => accs.has(String(r.account)))
      .map(async (r) => {
        const a = accs.get(String(r.account))!;
        return {
          _id: r._id,
          account: r.account,
          kind: r.kind,
          name: a.role ? a.name : r.name,
          code: a.code,
          bankName: r.bankName,
          accountNumber: r.accountNumber,
          sheba: r.sheba,
          holder: r.holder,
          pettyLimit: r.pettyLimit,
          lastReplenishedAt: r.lastReplenishedAt,
          isActive: r.isActive,
          statementBalance: r.statementBalance,
          statementDate: r.statementDate,
          balance: Math.round(await balanceOf(owner, r.account)),
        };
      }),
  );
};

// a new till, bank account, card reader or petty fund, with its opening
// balance booked (Nexxa createTreasuryAccount: Dr the account / Cr 5103)
export const openTreasuryAccount = async (
  owner: BizOwner,
  d: { kind: "cash" | "bank" | "pos" | "petty"; name: string; bankName?: string; accountNumber?: string; sheba?: string; holder?: string; pettyLimit?: number; opening?: number; date?: Date },
  by?: unknown,
) => {
  if (!d.name?.trim()) throw new AppError("نام صندوق یا حساب را بنویسید", 400);
  const row = await createMoneyAccount(owner, {
    kind: d.kind,
    name: d.name.trim().slice(0, 120),
    bankName: d.bankName?.trim().slice(0, 80) || undefined,
    accountNumber: d.accountNumber?.trim().slice(0, 40) || undefined,
    sheba: d.sheba?.replace(/\s/g, "").slice(0, 34) || undefined,
  });
  if (d.kind === "petty") {
    row.holder = d.holder?.trim().slice(0, 120) || undefined;
    row.pettyLimit = d.pettyLimit ? money(d.pettyLimit) : undefined;
    await row.save();
  }
  const opening = money(d.opening);
  if (opening > 0)
    await postVoucher(owner, {
      ref: `treasury:opening:${row._id}`,
      kind: "opening",
      date: d.date || new Date(),
      description: "مانده‌ی اولیه‌ی صندوق یا بانک",
      source: { type: "money", id: row._id },
      lines: [
        { accountId: row.account, label: `مانده‌ی اولیه‌ی ${row.name}`, debit: opening },
        { role: "openingBalance", label: `مانده‌ی اولیه‌ی ${row.name}`, credit: opening },
      ],
      createdBy: by,
    });
  return row.toObject();
};

export const updateTreasuryAccount = async (owner: BizOwner, id: string, d: { holder?: string; pettyLimit?: number }) => {
  const row = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: id });
  if (!row) throw new AppError("حساب پیدا نشد", 404);
  if (d.holder !== undefined) row.holder = d.holder.trim().slice(0, 120) || undefined;
  if (d.pettyLimit !== undefined) row.pettyLimit = money(d.pettyLimit) || undefined;
  await row.save();
  return row.toObject();
};

// ----------------------------------------------- transfers and fees

// Between two tills / banks / petty funds (Nexxa treasuryTransfer)
export const transferFunds = async (
  owner: BizOwner,
  d: { from: string; to: string; amount: number; date?: Date; description?: string; reference?: string },
  by?: unknown,
) => {
  const amount = money(d.amount);
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  if (!d.from || d.from === d.to) throw new AppError("مبدأ و مقصد نباید یکسان باشند", 400);
  const [from, to] = await Promise.all([moneyAccountRow(owner, d.from), moneyAccountRow(owner, d.to)]);
  if (String(from.account) === String(to.account)) throw new AppError("مبدأ و مقصد نباید یکسان باشند", 400);
  await enforceNegative(owner, from.account, from.name, amount, "انتقال وجه");
  const seq = await nextDocNumber("transfer", owner);
  const note = d.description?.trim().slice(0, 200);
  const v = await postVoucher(owner, {
    ref: `trf:${seq}`,
    date: d.date || new Date(),
    description: "انتقال وجه بین حساب‌ها",
    reference: d.reference?.trim().slice(0, 80) || undefined,
    source: { type: "transfer", id: oid(d.from) },
    lines: [
      { accountId: to.account, label: note ? `${note} — به ${to.name}` : `انتقال به ${to.name}`, debit: amount },
      { accountId: from.account, label: note ? `${note} — از ${from.name}` : `انتقال از ${from.name}`, credit: amount },
    ],
    createdBy: by,
  });
  if (to.row?.kind === "petty") await BizMoneyAccount.updateOne({ _id: to.row._id }, { $set: { lastReplenishedAt: d.date || new Date() } });
  return v;
};

// the transfers (حواله‌ها), newest first, and whether each was voided
export const listTransfers = async (owner: BizOwner) => {
  const items = await BizVoucher.find({ ...ownerFilter(owner), "source.type": "transfer" }).sort({ date: -1, number: -1 }).limit(300).lean<IBizVoucher[]>();
  const voided = new Set(items.filter((v) => v.ref?.endsWith(":void")).map((v) => v.ref!.replace(/:void$/, "")));
  return items
    .filter((v) => !v.ref?.endsWith(":void"))
    .map((v) => ({
      _id: v._id,
      number: v.number,
      date: v.date,
      ref: v.ref,
      reference: v.reference,
      amount: v.total,
      to: v.lines.find((l) => l.debit > 0)?.label || "",
      from: v.lines.find((l) => l.credit > 0)?.label || "",
      void: voided.has(v.ref || ""),
    }));
};

// a transfer taken back (Nexxa deleteRemittance): its reversal is booked,
// both balances come back
export const voidTransfer = async (owner: BizOwner, id: string, by?: unknown) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("انتقال پیدا نشد", 404);
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id, "source.type": "transfer" }).lean<IBizVoucher>();
  if (!v || !v.ref) throw new AppError("انتقال پیدا نشد", 404);
  return postVoucher(owner, {
    ref: `${v.ref}:void`,
    date: new Date(),
    description: "ابطال انتقال وجه",
    source: v.source,
    lines: v.lines.map((l) => ({ accountId: l.account, label: l.label, debit: l.credit, credit: l.debit })),
    createdBy: by,
  });
};

// a bank charge (Nexxa recordBankFee: Dr 7208 / Cr the bank)
export const recordBankFee = async (owner: BizOwner, d: { money: string; amount: number; date?: Date; description?: string }, by?: unknown) => {
  const amount = money(d.amount);
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  const credit = await treasuryCredit(owner, d.money, amount, "کارمزد بانکی");
  const seq = await nextDocNumber("bankfee", owner);
  return postVoucher(owner, {
    ref: `bankfee:${seq}`,
    date: d.date || new Date(),
    description: "کارمزد و هزینه‌ی بانکی",
    source: { type: "bankFee", id: oid(credit.accountId) },
    lines: [{ role: "bankFees", label: d.description?.slice(0, 200) || "کارمزد بانکی", debit: amount }, { ...credit, label: d.description?.slice(0, 200) || "کارمزد بانکی" }],
    createdBy: by,
  });
};

// ------------------------------------------------------- petty cash

// a petty fund topped up from a till or bank (Nexxa postPettyCashCharge:
// Dr the petty fund / Cr the bank)
export const chargePetty = async (owner: BizOwner, d: { petty: string; from: string; amount: number; date?: Date; note?: string; ref?: string }, by?: unknown) => {
  const petty = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: d.petty, kind: "petty" }).lean<IBizMoneyAccount>();
  if (!petty) throw new AppError("تنخواه پیدا نشد", 404);
  const amount = money(d.amount);
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  const credit = await treasuryCredit(owner, d.from, amount, "شارژ تنخواه");
  const seq = d.ref ? null : await nextDocNumber("petty", owner);
  const who = petty.holder ? ` — ${petty.holder}` : "";
  const v = await postVoucher(owner, {
    ref: d.ref || `petty:${seq}`,
    date: d.date || new Date(),
    description: "شارژ تنخواه",
    source: { type: "petty", id: petty._id },
    lines: [
      { accountId: petty.account, label: `شارژ تنخواه${who}${d.note ? ` (${d.note.slice(0, 100)})` : ""}`, debit: amount },
      { ...credit, label: `پرداخت تنخواه${who}` },
    ],
    createdBy: by,
  });
  await BizMoneyAccount.updateOne({ _id: petty._id }, { $set: { lastReplenishedAt: d.date || new Date() } });
  return v;
};

// what a petty fund spent since its last top-up, and the top-up that
// brings it back to its ceiling (تنخواه گردان)
export const pettyStatus = async (owner: BizOwner, id: string) => {
  const petty = await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: id, kind: "petty" }).lean<IBizMoneyAccount>();
  if (!petty) throw new AppError("تنخواه پیدا نشد", 404);
  const since = petty.lastReplenishedAt || new Date(0);
  const spent = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), date: { $gte: since }, "lines.account": petty.account } },
    { $sort: { date: -1 } },
    { $unwind: "$lines" },
    { $match: { "lines.account": petty.account, "lines.credit": { $gt: 0 } } },
    { $project: { number: 1, date: 1, description: 1, label: "$lines.label", amount: "$lines.credit" } },
  ]);
  const balance = Math.round(await balanceOf(owner, petty.account));
  const total = spent.reduce((s, r) => s + r.amount, 0);
  return {
    petty,
    balance,
    spent,
    totalSpent: total,
    suggested: petty.pettyLimit ? Math.max(0, petty.pettyLimit - balance) : total,
  };
};

// ---------------------------------------------------- bank statements

const DATE_HEADS = ["تاریخ", "date"];
const AMOUNT_HEADS = ["مبلغ", "amount"];
const DEBIT_HEADS = ["برداشت", "بدهکار", "debit", "withdrawal"];
const CREDIT_HEADS = ["واریز", "بستانکار", "credit", "deposit"];
const DESC_HEADS = ["شرح", "توضیحات", "description", "narration"];
const REF_HEADS = ["شماره پیگیری", "پیگیری", "مرجع", "سند", "reference", "ref"];
const BAL_HEADS = ["مانده", "balance"];

const norm = (s: unknown) => String(s ?? "").replace(/[‌\s]+/g, " ").trim().toLowerCase();
const latinNum = (s: unknown) =>
  String(s ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const amountOf = (v: unknown) => {
  if (typeof v === "number") return v;
  const s = latinNum(v).replace(/[,٬\s]/g, "");
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
};

// a Jalali (1405/07/12, 14050712) or Gregorian date, or an Excel date
export const dateOf = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = latinNum(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1700) {
    const j = moment.utc(`${y}/${mo}/${d}`, "jYYYY/jM/jD");
    return j.isValid() ? new Date(j.valueOf() - 210 * 60000 + 12 * 3600000) : null;
  }
  const g = new Date(Date.UTC(y, mo - 1, d, 8, 30));
  return Number.isNaN(g.getTime()) ? null : g;
};

export type StatementMapping = { date: number; amount?: number; debit?: number; credit?: number; description?: number; reference?: number; balance?: number; header: number };

// reads the file and guesses which column is which
export const previewStatement = async (file: Buffer, name: string) => {
  const rows = (await sheetRows(file, name)).slice(0, 2000);
  let header = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(norm);
    if (cells.some((c) => DATE_HEADS.some((h) => c.includes(h)))) {
      header = i;
      break;
    }
  }
  const head = header >= 0 ? rows[header].map(norm) : [];
  const find = (keys: string[]) => {
    const i = head.findIndex((c) => keys.some((k) => c.includes(k)));
    return i >= 0 ? i : undefined;
  };
  const mapping: StatementMapping = {
    header,
    date: find(DATE_HEADS) ?? 0,
    amount: find(AMOUNT_HEADS),
    debit: find(DEBIT_HEADS),
    credit: find(CREDIT_HEADS),
    description: find(DESC_HEADS),
    reference: find(REF_HEADS),
    balance: find(BAL_HEADS),
  };
  return { columns: header >= 0 ? rows[header].map((c) => String(c ?? "")) : (rows[0] || []).map((_, i) => `#${i + 1}`), sample: rows.slice(header + 1, header + 6), mapping, rows: rows.length - header - 1 };
};

// Imports a statement's lines into a bank account (Nexxa
// BankStatementImport): a line seen before (same date, amount, reference
// and description) is skipped; then auto-matching runs.
export const importStatement = async (owner: BizOwner, moneyId: string, file: Buffer, name: string, mapping: StatementMapping) => {
  const m = await moneyAccountRow(owner, moneyId);
  if (!m.row) throw new AppError("حساب بانکی را انتخاب کنید", 400);
  const rows = (await sheetRows(file, name)).slice(Math.max(0, (mapping.header ?? -1) + 1), 5000);
  const batch = crypto.randomBytes(6).toString("hex");
  let added = 0;
  let duplicates = 0;
  let invalid = 0;
  for (const r of rows) {
    const date = dateOf(r[mapping.date]);
    let amount = 0;
    if (mapping.amount !== undefined && mapping.amount !== null) amount = amountOf(r[mapping.amount]);
    else amount = amountOf(mapping.credit !== undefined ? r[mapping.credit] : 0) - amountOf(mapping.debit !== undefined ? r[mapping.debit] : 0);
    amount = Math.round(amount);
    if (!date || !amount) {
      invalid++;
      continue;
    }
    const description = mapping.description !== undefined ? String(r[mapping.description] ?? "").trim().slice(0, 300) : "";
    const reference = mapping.reference !== undefined ? latinNum(r[mapping.reference]).trim().slice(0, 80) : "";
    const balance = mapping.balance !== undefined ? amountOf(r[mapping.balance]) : undefined;
    const hash = crypto.createHash("sha1").update(`${date.toISOString().slice(0, 10)}|${amount}|${reference}|${description}`).digest("hex");
    try {
      await BizBankLine.create({ ...ownerFields(owner), money: m.row._id, date, amount, description, reference, balance, batch, hash });
      added++;
    } catch (err: any) {
      if (err?.code === 11000) duplicates++;
      else throw err;
    }
  }
  const last = await BizBankLine.findOne({ ...ownerFilter(owner), money: m.row._id, balance: { $exists: true } }).sort({ date: -1, createdAt: -1 }).lean<IBizBankLine>();
  if (last?.balance !== undefined) await BizMoneyAccount.updateOne({ _id: m.row._id }, { $set: { statementBalance: Math.round(last.balance), statementDate: last.date } });
  const matched = await autoMatch(owner, moneyId);
  return { added, duplicates, invalid, matched: matched.matched };
};

// book lines of a money account not yet reconciled
const openBookLines = async (owner: BizOwner, row: IBizMoneyAccount) => {
  const lines = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $nin: ["final", "open"] }, "lines.account": row.account, _id: { $nin: row.reconciled || [] } } },
    { $unwind: "$lines" },
    { $match: { "lines.account": row.account } },
    { $group: { _id: "$_id", date: { $first: "$date" }, number: { $first: "$number" }, description: { $first: "$description" }, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
    { $sort: { date: -1 } },
    { $limit: 2000 },
  ]);
  return lines.map((l) => ({ _id: String(l._id), date: l.date as Date, number: l.number as number, description: l.description as string, amount: Math.round(l.d - l.c) }));
};

// Nexxa bank-match-core over the open lines: same signed amount, closest
// date within the window, one to one
export const autoMatch = async (owner: BizOwner, moneyId: string) => {
  const m = await moneyAccountRow(owner, moneyId);
  if (!m.row) throw new AppError("حساب بانکی را انتخاب کنید", 400);
  const { matchDays } = await getSettings(owner);
  const stmt = await BizBankLine.find({ ...ownerFilter(owner), money: m.row._id, status: "open" }).lean<IBizBankLine[]>();
  const book = await openBookLines(owner, m.row);
  const r = matchStatement(
    book.map((b) => ({ id: b._id, date: new Date(b.date).getTime(), amount: b.amount })),
    stmt.map((s) => ({ date: new Date(s.date).getTime(), amount: s.amount })),
    matchDays ?? 5,
  );
  for (const x of r.matches) {
    const s = stmt[x.stmtIndex];
    await BizBankLine.updateOne({ _id: s._id, status: "open" }, { $set: { status: "matched", voucher: oid(x.bookId) } });
  }
  if (r.matches.length) await BizMoneyAccount.updateOne({ _id: m.row._id }, { $addToSet: { reconciled: { $each: r.matches.map((x) => oid(x.bookId)) } } });
  return { matched: r.matches.length };
};

export const bankRec = async (owner: BizOwner, moneyId: string) => {
  const m = await moneyAccountRow(owner, moneyId);
  if (!m.row) throw new AppError("حساب بانکی را انتخاب کنید", 400);
  const row = (await BizMoneyAccount.findById(m.row._id).lean<IBizMoneyAccount>())!;
  const [stmt, book, balance] = await Promise.all([
    BizBankLine.find({ ...ownerFilter(owner), money: row._id }).sort({ date: -1 }).limit(1000).lean<IBizBankLine[]>(),
    openBookLines(owner, row),
    balanceOf(owner, row.account),
  ]);
  const stmtTotal = stmt.reduce((s, l) => s + (l.status !== "ignored" ? l.amount : 0), 0);
  return {
    account: { _id: row._id, name: m.name, statementBalance: row.statementBalance, statementDate: row.statementDate },
    bookBalance: Math.round(balance),
    statement: stmt,
    unmatchedBook: book,
    summary: {
      openStatement: stmt.filter((l) => l.status === "open").length,
      openBook: book.length,
      openBookSum: book.reduce((s, l) => s + l.amount, 0),
      openStatementSum: stmt.filter((l) => l.status === "open").reduce((s, l) => s + l.amount, 0),
      statementTotal: stmtTotal,
      // statement balance + what the books have that the bank does not yet
      // - what the bank has that the books do not = the book balance
      difference: row.statementBalance !== undefined ? Math.round(balance - (row.statementBalance + book.reduce((s, l) => s + l.amount, 0) - stmt.filter((l) => l.status === "open").reduce((s, l) => s + l.amount, 0))) : null,
    },
  };
};

export const matchLine = async (owner: BizOwner, lineId: string, voucherId: string) => {
  const l = await BizBankLine.findOne({ ...ownerFilter(owner), _id: lineId });
  if (!l) throw new AppError("ردیف صورت‌حساب پیدا نشد", 404);
  if (!mongoose.isValidObjectId(voucherId)) throw new AppError("سند پیدا نشد", 404);
  const row = await BizMoneyAccount.findById(l.money).lean<IBizMoneyAccount>();
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: voucherId, "lines.account": row?.account }).lean();
  if (!v || !row) throw new AppError("سند پیدا نشد", 404);
  l.status = "matched";
  l.voucher = v._id;
  await l.save();
  await BizMoneyAccount.updateOne({ _id: row._id }, { $addToSet: { reconciled: v._id } });
  return l.toObject();
};

export const unmatchLine = async (owner: BizOwner, lineId: string) => {
  const l = await BizBankLine.findOne({ ...ownerFilter(owner), _id: lineId });
  if (!l) throw new AppError("ردیف صورت‌حساب پیدا نشد", 404);
  if (l.voucher) await BizMoneyAccount.updateOne({ _id: l.money }, { $pull: { reconciled: l.voucher } });
  l.status = "open";
  l.voucher = undefined;
  await l.save();
  return l.toObject();
};

export const ignoreLine = async (owner: BizOwner, lineId: string, ignored: boolean) => {
  const l = await BizBankLine.findOne({ ...ownerFilter(owner), _id: lineId });
  if (!l) throw new AppError("ردیف صورت‌حساب پیدا نشد", 404);
  if (l.status === "matched") throw new AppError("این ردیف تطبیق خورده است", 400);
  l.status = ignored ? "ignored" : "open";
  await l.save();
  return l.toObject();
};

// a statement line the books do not have yet (a bank charge, an interest,
// a deposit nobody recorded): booked against the chosen account and matched
export const bookLine = async (owner: BizOwner, lineId: string, d: { account: string; party?: string; description?: string }, by?: unknown) => {
  const l = await BizBankLine.findOne({ ...ownerFilter(owner), _id: lineId, status: "open" });
  if (!l) throw new AppError("ردیف صورت‌حساب پیدا نشد", 404);
  const row = await BizMoneyAccount.findById(l.money).lean<IBizMoneyAccount>();
  if (!row) throw new AppError("حساب بانکی را انتخاب کنید", 400);
  if (!mongoose.isValidObjectId(d.account)) throw new AppError("حساب ردیف سند پیدا نشد", 400);
  const party = d.party ? await resolveParty(owner, d.party) : null;
  const label = (d.description || l.description || "ردیف صورت‌حساب بانک").slice(0, 300);
  const amount = Math.abs(l.amount);
  const v = await postVoucher(owner, {
    ref: `bankline:${l._id}`,
    date: l.date,
    description: "ثبت از صورت‌حساب بانک",
    reference: l.reference || undefined,
    source: { type: "bankLine", id: l._id },
    lines:
      l.amount > 0
        ? [
            { accountId: row.account, label, debit: amount },
            { accountId: d.account, party: party?._id, label, credit: amount },
          ]
        : [
            { accountId: d.account, party: party?._id, label, debit: amount },
            { accountId: row.account, label, credit: amount },
          ],
    createdBy: by,
  });
  if (!v) throw new AppError("سند ثبت نشد", 400);
  l.status = "matched";
  l.voucher = v._id;
  await l.save();
  await BizMoneyAccount.updateOne({ _id: row._id }, { $addToSet: { reconciled: v._id } });
  return v;
};

export const deleteStatementBatch = async (owner: BizOwner, moneyId: string, batch?: string) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner), money: oid(moneyId), status: { $ne: "matched" } };
  if (batch) filter.batch = batch;
  const r = await BizBankLine.deleteMany(filter);
  return { deleted: r.deletedCount };
};

// ------------------------------------------------------------- cheques

// a received cheque handed to the bank for collection: no voucher, its
// status only (Nexxa updateCheckState → deposited)
export const depositCheque = async (owner: BizOwner, id: string, d: { money?: string; date?: Date; note?: string }) => {
  const p = await BizPayment.findOne({ ...ownerFilter(owner), _id: id, method: "cheque", direction: "in", isVoid: false });
  if (!p?.cheque) throw new AppError("چک پیدا نشد", 404);
  if (p.cheque.status !== "pending") throw new AppError("این تغییر وضعیت برای این چک ممکن نیست", 400);
  p.cheque.status = "deposited";
  p.cheque.statusAt = d.date || new Date();
  if (d.money && mongoose.isValidObjectId(d.money)) p.money = oid(d.money);
  p.cheque.history.push({ status: "deposited", at: d.date || new Date(), note: d.note?.slice(0, 300) });
  p.markModified("cheque");
  await p.save();
  return p.toObject();
};

// a received cheque passed on to a supplier (خرج چک, Nexxa endorseCheck):
// Dr the supplier's payable / Cr 1415
export const endorseCheque = async (owner: BizOwner, id: string, d: { party?: string; partyName?: string; date?: Date; note?: string }, by?: unknown) => {
  const p = await BizPayment.findOne({ ...ownerFilter(owner), _id: id, method: "cheque", direction: "in", isVoid: false });
  if (!p?.cheque) throw new AppError("چک پیدا نشد", 404);
  if (!["pending", "deposited"].includes(p.cheque.status)) throw new AppError("این تغییر وضعیت برای این چک ممکن نیست", 400);
  const party = d.party
    ? await resolveParty(owner, d.party)
    : d.partyName?.trim()
      ? await resolveParty(owner, { kind: "supplier", name: d.partyName.trim() })
      : null;
  if (!party) throw new AppError("گیرنده‌ی چک را انتخاب کنید", 400);
  const date = d.date || new Date();
  const label = `خرج چک ${p.cheque.number} به ${party.name}`;
  // (2026-10) the cheque leaves 1415 from the تفصیلی it came in on (the
  // payer), or the payer's statement keeps showing a cheque already passed on
  const held = await BizVoucher.findOne({ ...ownerFilter(owner), ref: `pay:${p._id}` }).lean<IBizVoucher>();
  const acc1415 = await accountFor(owner, "chequesReceivable");
  const payer = held?.lines.find((l) => String(l.account) === String(acc1415._id) && l.debit > 0)?.party;
  await postVoucher(owner, {
    ref: await chequeMoveRef(owner, p._id, p.cheque.history.length),
    date,
    description: "خرج چک دریافتی",
    source: { type: "payment", id: p._id },
    lines: [
      { role: "payable", party: party._id, label, debit: p.amount },
      { role: "chequesReceivable", label, credit: p.amount, ...(payer ? { party: payer } : {}) },
    ],
    createdBy: by,
  });
  p.cheque.status = "endorsed";
  p.cheque.statusAt = date;
  p.cheque.endorsedTo = party._id;
  p.cheque.endorsedToName = party.name;
  p.cheque.history.push({ status: "endorsed", at: date, note: d.note?.slice(0, 300) || party.name });
  p.markModified("cheque");
  await p.save();
  return p.toObject();
};

// Undoes a cheque's last move (Nexxa revertCheckState): the voucher that
// move wrote is reversed and the cheque is back where it was.
export const revertCheque = async (owner: BizOwner, id: string, by?: unknown) => {
  const p = await BizPayment.findOne({ ...ownerFilter(owner), _id: id, method: "cheque", isVoid: false });
  if (!p?.cheque) throw new AppError("چک پیدا نشد", 404);
  const h = p.cheque.history;
  if (h.length < 2) throw new AppError("این چک وضعیتی برای برگرداندن ندارد", 400);
  // the live voucher of the last move (a move made again after an undo has its own ref)
  const v = await chequeMoveVoucher(owner, p._id, h.length - 1);
  if (v?.ref)
    await postVoucher(owner, {
      ref: `${v.ref}:void`,
      date: new Date(),
      description: "لغو آخرین وضعیت چک",
      source: v.source,
      lines: v.lines.map((l) => ({ accountId: l.account, party: l.party, label: l.label, debit: l.credit, credit: l.debit })),
      createdBy: by,
    });
  h.pop();
  const prev = h[h.length - 1];
  p.cheque.status = prev.status;
  p.cheque.statusAt = prev.at;
  if (prev.status !== "endorsed") {
    p.cheque.endorsedTo = undefined;
    p.cheque.endorsedToName = undefined;
  }
  p.markModified("cheque");
  await p.save();
  await syncDoc(owner, p);
  return p.toObject();
};

// ------------------------------------------------------ cheque books

export const listCheckbooks = async (owner: BizOwner) => {
  const books = await BizCheckbook.find(ownerFilter(owner)).sort({ createdAt: -1 }).lean<IBizCheckbook[]>();
  const used = await BizPayment.aggregate([
    { $match: { ...ownerFilter(owner), method: "cheque", direction: "out", "cheque.checkbook": { $in: books.map((b) => b._id) } } },
    { $group: { _id: "$cheque.checkbook", n: { $sum: 1 } } },
  ]);
  const usedBy = new Map(used.map((u) => [String(u._id), u.n]));
  // (2026-10) the next leaf not written yet, for the payment form
  const leaves = await BizPayment.find({ ...ownerFilter(owner), method: "cheque", direction: "out", isVoid: false, "cheque.checkbook": { $in: books.map((b) => b._id) } })
    .select("cheque.checkbook cheque.number")
    .lean<{ cheque?: { checkbook?: unknown; number?: string } }[]>();
  const taken = new Set(leaves.map((l) => `${String(l.cheque?.checkbook)}:${latinNum(l.cheque?.number).replace(/\D/g, "")}`));
  const nextOf = (b: IBizCheckbook) => {
    if (!/^\d+$/.test(b.fromNo || "") || !/^\d+$/.test(b.toNo || "")) return undefined;
    for (let n = BigInt(b.fromNo), i = 0; n <= BigInt(b.toNo) && i < 2000; n++, i++) {
      const no = n.toString().padStart(b.fromNo.length, "0");
      if (!taken.has(`${String(b._id)}:${no}`)) return no;
    }
    return undefined;
  };
  return books.map((b) => ({ ...b, used: usedBy.get(String(b._id)) || 0, nextNo: nextOf(b) }));
};

export const saveCheckbook = async (owner: BizOwner, d: { id?: string; money?: string; serial: string; fromNo: string; toNo: string; count?: number; description?: string; isActive?: boolean }) => {
  const serial = (d.serial || "").trim();
  const fromNo = latinNum(d.fromNo).replace(/\D/g, "");
  const toNo = latinNum(d.toNo).replace(/\D/g, "");
  if (!serial || !fromNo || !toNo) throw new AppError("سری و بازه‌ی شماره‌های دسته‌چک را وارد کنید", 400);
  const span = Number(toNo) - Number(fromNo) + 1;
  const count = d.count && d.count > 0 ? Math.round(d.count) : span > 0 && span < 1000 ? span : 0;
  const m = d.money && mongoose.isValidObjectId(d.money) ? await BizMoneyAccount.findOne({ ...ownerFilter(owner), _id: d.money }).lean<IBizMoneyAccount>() : null;
  const set = { serial: serial.slice(0, 40), fromNo, toNo, count, description: d.description?.slice(0, 300), money: m?._id, bankName: m?.bankName || m?.name, ...(d.isActive !== undefined ? { isActive: d.isActive } : {}) };
  if (d.id) {
    const doc = await BizCheckbook.findOneAndUpdate({ ...ownerFilter(owner), _id: d.id }, { $set: set }, { new: true }).lean();
    if (!doc) throw new AppError("دسته‌چک پیدا نشد", 404);
    return doc;
  }
  return (await BizCheckbook.create({ ...ownerFields(owner), ...set })).toObject();
};

export const deleteCheckbook = async (owner: BizOwner, id: string) => {
  const r = await BizCheckbook.deleteOne({ ...ownerFilter(owner), _id: id });
  if (!r.deletedCount) throw new AppError("دسته‌چک پیدا نشد", 404);
};

// ------------------------------------------------------ trust cheques

export const listTrust = (owner: BizOwner) => BizTrustCheque.find(ownerFilter(owner)).sort({ dueDate: 1 }).lean<IBizTrustCheque[]>();

export const saveTrust = async (
  owner: BizOwner,
  d: { id?: string; serial: string; bank?: string; amount: number; dueDate?: Date; party?: string; partyName?: string; purpose?: string },
) => {
  const serial = latinNum(d.serial).trim();
  const amount = money(d.amount);
  if (!serial || !amount || !d.dueDate || Number.isNaN(d.dueDate.getTime())) throw new AppError("شماره، مبلغ و سررسید چک را وارد کنید", 400);
  const party = d.party ? await resolveParty(owner, d.party) : null;
  const set = { serial: serial.slice(0, 40), bank: d.bank?.slice(0, 80), amount, dueDate: d.dueDate, party: party?._id, partyName: party?.name || d.partyName?.slice(0, 200), purpose: d.purpose?.slice(0, 300) };
  if (d.id) {
    const doc = await BizTrustCheque.findOneAndUpdate({ ...ownerFilter(owner), _id: d.id }, { $set: set }, { new: true }).lean();
    if (!doc) throw new AppError("چک پیدا نشد", 404);
    return doc;
  }
  return (await BizTrustCheque.create({ ...ownerFields(owner), ...set })).toObject();
};

// given back to its drawer: the record goes (Nexxa releaseTrustCheck)
export const releaseTrust = async (owner: BizOwner, id: string) => {
  const r = await BizTrustCheque.deleteOne({ ...ownerFilter(owner), _id: id });
  if (!r.deletedCount) throw new AppError("چک پیدا نشد", 404);
};

export type ChequeRow = IBizPayment;
