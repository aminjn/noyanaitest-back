import mongoose from "mongoose";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher from "../../Models/BizVoucher";
import BizParty, { IBizParty } from "../../Models/BizParty";
import { BizOwner, displayName, ensureChart, natural, ownerFilter } from "./coa";
import { accountRows, WITHOUT_TRANSFER } from "./reports";
import { trialRow } from "./accCore";
import { partyNames } from "./parties";
import { Locale } from "../locales";

// The books (2026-10), after Nexxa's general-ledger (دفتر معین: one
// account's lines, filterable by تفصیلی and cost centre, with a running
// balance), total-ledger (دفتر کل: each کل account's opening, turnover and
// closing), statements/[id] (a party's ledger), treasury-ledger (a till or
// bank's running balance), trial-balance (2/4/6/8 columns at group / total
// / detail level, and here also per party) and review (مرور حساب‌ها: the
// tree down to تفصیلی). Every figure is summed from voucher lines; drafts
// and the year-end transfer vouchers are left out.

const oid = (v: string) => new mongoose.Types.ObjectId(v);
const escape = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type LedgerQuery = {
  account?: string;
  party?: string;
  center?: string;
  from: Date | null;
  to: Date | null;
  page: number;
  limit: number;
};

// One account (of any level), one party, or both - with the running
// balance in the account's nature (a party alone: debit - credit).
export const ledgerOf = async (owner: BizOwner, q: LedgerQuery, locale: Locale) => {
  await ensureChart(owner);
  let account: IBizAccount | null = null;
  let codes: string[] | null = null;
  if (q.account && mongoose.isValidObjectId(q.account)) {
    account = await BizAccount.findOne({ ...ownerFilter(owner), _id: q.account }).lean<IBizAccount>();
    if (!account) return null;
    codes =
      account.level === "detail"
        ? [account.code]
        : (
            await BizAccount.find({ ...ownerFilter(owner), code: { $regex: `^${escape(account.code)}` }, level: "detail" })
              .select("code")
              .lean<{ code: string }[]>()
          ).map((a) => a.code);
  }
  let party: IBizParty | null = null;
  if (q.party && mongoose.isValidObjectId(q.party)) {
    party = await BizParty.findOne({ ...ownerFilter(owner), _id: q.party }).lean<IBizParty>();
    if (!party) return null;
  }
  if (!codes && !party) return null;
  const lineMatch: Record<string, unknown> = {};
  if (codes) lineMatch["lines.code"] = { $in: codes };
  if (party) lineMatch["lines.party"] = party._id;
  const centerStage =
    q.center && mongoose.isValidObjectId(q.center)
      ? [{ $match: { $expr: { $eq: [{ $ifNull: ["$lines.center", "$center"] }, oid(q.center)] } } }]
      : [];
  const pre = { ...ownerFilter(owner), phase: { $nin: WITHOUT_TRANSFER }, ...(codes ? { "lines.code": { $in: codes } } : {}), ...(party ? { "lines.party": party._id } : {}) };
  const type = account?.type || "asset";
  const nat = (d: number, c: number) => (account ? natural(type, d, c) : d - c);
  const [openingAgg] = q.from
    ? await BizVoucher.aggregate([
        { $match: { ...pre, date: { $lt: q.from } } },
        { $unwind: "$lines" },
        { $match: lineMatch },
        ...centerStage,
        { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
      ])
    : [null];
  const range = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const all = await BizVoucher.aggregate([
    { $match: { ...pre, ...(q.from || q.to ? { date: range } : {}) } },
    { $sort: { date: 1, number: 1 } },
    { $unwind: "$lines" },
    { $match: lineMatch },
    ...centerStage,
    {
      $project: {
        number: 1,
        date: 1,
        description: 1,
        reference: 1,
        kind: 1,
        source: 1,
        label: "$lines.label",
        code: "$lines.code",
        party: "$lines.party",
        center: { $ifNull: ["$lines.center", "$center"] },
        debit: "$lines.debit",
        credit: "$lines.credit",
      },
    },
  ]);
  const opening = nat(openingAgg?.d || 0, openingAgg?.c || 0);
  let running = opening;
  let totalD = 0;
  let totalC = 0;
  const rows = all.map((l) => {
    running += nat(l.debit, l.credit);
    totalD += l.debit;
    totalC += l.credit;
    return { ...l, balance: running };
  });
  // names for the page only (oldest first, the way a ledger is read)
  const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  const accNames = new Map(
    (await BizAccount.find({ ...ownerFilter(owner), code: { $in: [...new Set(page.map((r) => r.code))] } }).select("code name role").lean<IBizAccount[]>()).map((a) => [
      a.code,
      displayName(a, locale),
    ]),
  );
  const parties = await partyNames(page.map((r) => r.party));
  return {
    account: account ? { ...account, name: displayName(account, locale) } : null,
    party,
    opening,
    closing: running,
    totalDebit: totalD,
    totalCredit: totalC,
    total: rows.length,
    items: page.map((r) => ({ ...r, accountName: accNames.get(r.code) || "", party: r.party ? parties.get(String(r.party)) || null : null })),
  };
};

// دفتر کل: every کل (or گروه) account's opening, period turnover and closing
export const totalLedger = async (owner: BizOwner, from: Date | null, to: Date | null, level: "group" | "total", locale: Locale, center?: string) => {
  const rows = await accountRows(owner, from, to, WITHOUT_TRANSFER, { center });
  return rows
    .filter((r) => r.level === level)
    .map((r) => ({
      _id: r._id,
      code: r.code,
      name: displayName(r, locale),
      type: r.type,
      opening: r.bD - r.bC,
      debit: r.pD,
      credit: r.pC,
      closing: r.bD + r.pD - (r.bC + r.pC),
    }))
    .filter((r) => Math.abs(r.opening) > 0.5 || r.debit > 0.5 || r.credit > 0.5 || Math.abs(r.closing) > 0.5);
};

// Trial balance at a level, every column a 2/4/6/8-column report needs
// (the page picks which to show): opening, turnover, cumulative, closing.
export const trial = async (
  owner: BizOwner,
  q: { level: "group" | "total" | "detail" | "party"; from: Date | null; to: Date | null; center?: string },
  locale: Locale,
) => {
  if (q.level === "party") {
    const match: Record<string, unknown> = { ...ownerFilter(owner), phase: { $nin: WITHOUT_TRANSFER } };
    if (q.to) match.date = { $lte: q.to };
    const from = q.from || new Date(0);
    const agg = await BizVoucher.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $match: { "lines.party": { $exists: true } } },
      {
        $group: {
          _id: { party: "$lines.party", code: "$lines.code" },
          openD: { $sum: { $cond: [{ $lt: ["$date", from] }, "$lines.debit", 0] } },
          openC: { $sum: { $cond: [{ $lt: ["$date", from] }, "$lines.credit", 0] } },
          turnD: { $sum: { $cond: [{ $gte: ["$date", from] }, "$lines.debit", 0] } },
          turnC: { $sum: { $cond: [{ $gte: ["$date", from] }, "$lines.credit", 0] } },
        },
      },
    ]);
    const parties = await partyNames(agg.map((a) => a._id.party));
    const accs = new Map(
      (await BizAccount.find({ ...ownerFilter(owner), code: { $in: [...new Set(agg.map((a) => a._id.code))] } }).lean<IBizAccount[]>()).map((a) => [a.code, a]),
    );
    const rows = agg
      .map((a) => {
        const p = parties.get(String(a._id.party));
        const acc = accs.get(a._id.code);
        return {
          ...trialRow({ code: `${a._id.code}-${p?.code || ""}`, name: `${p?.name || "—"} · ${acc ? displayName(acc, locale) : a._id.code}`, ...a }),
          party: p?._id,
          account: acc?._id,
        };
      })
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
    return { rows, balanced: balancedOf(rows) };
  }
  const all = await accountRows(owner, q.from, q.to, WITHOUT_TRANSFER, { center: q.center });
  const rows = all
    .filter((r) => r.level === q.level && (r.bD || r.bC || r.pD || r.pC))
    .map((r) => ({ ...trialRow({ code: r.code, name: displayName(r, locale), openD: r.bD, openC: r.bC, turnD: r.pD, turnC: r.pC }), account: r._id, type: r.type }))
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  return { rows, balanced: balancedOf(rows) };
};

const balancedOf = (rows: { closeDebit: number; closeCredit: number; turnDebit: number; turnCredit: number }[]) => {
  const s = (k: "closeDebit" | "closeCredit" | "turnDebit" | "turnCredit") => rows.reduce((t, r) => t + r[k], 0);
  return Math.abs(s("closeDebit") - s("closeCredit")) < 1 && Math.abs(s("turnDebit") - s("turnCredit")) < 1;
};

// مرور حساب‌ها: the chart as a tree with balances, each detail account
// broken down by its parties (Nexxa accounting/review).
export const reviewTree = async (owner: BizOwner, from: Date | null, to: Date | null, locale: Locale) => {
  const rows = await accountRows(owner, from, to);
  const match: Record<string, unknown> = { ...ownerFilter(owner), phase: { $nin: WITHOUT_TRANSFER } };
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (from || to) match.date = range;
  const byParty = await BizVoucher.aggregate([
    { $match: match },
    { $unwind: "$lines" },
    { $match: { "lines.party": { $exists: true } } },
    { $group: { _id: { code: "$lines.code", party: "$lines.party" }, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  const parties = await partyNames(byParty.map((b) => b._id.party));
  const tafsili = new Map<string, { _id: string; code: string; name: string; debit: number; credit: number }[]>();
  for (const b of byParty) {
    const p = parties.get(String(b._id.party));
    if (!p) continue;
    const list = tafsili.get(b._id.code) || [];
    list.push({ _id: p._id, code: p.code, name: p.name, debit: b.d, credit: b.c });
    tafsili.set(b._id.code, list);
  }
  return rows
    .filter((r) => r.pD || r.pC)
    .map((r) => ({
      _id: r._id,
      code: r.code,
      name: displayName(r, locale),
      level: r.level,
      parentCode: r.parentCode,
      type: r.type,
      debit: r.pD,
      credit: r.pC,
      balance: r.period,
      parties: r.level === "detail" ? (tafsili.get(r.code) || []).map((p) => ({ ...p, balance: natural(r.type, p.debit, p.credit) })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)) : undefined,
    }));
};
