import mongoose from "mongoose";
import ExcelJS from "exceljs";
import BizInvoice, { IBizInvoice } from "../../Models/BizInvoice";
import BizExpense, { IBizExpense } from "../../Models/BizExpense";
import BizPurchase, { IBizPurchase } from "../../Models/BizPurchase";
import BizSupplier, { IBizSupplier } from "../../Models/BizSupplier";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizParty, { IBizParty } from "../../Models/BizParty";
import BizPayment, { IBizPayment } from "../../Models/BizPayment";
import BizFiscalYear from "../../Models/BizFiscalYear";
import { BizFixedAsset, IBizFixedAsset } from "../../Models/BizFixedAsset";
import { BizPriceItem, IBizPriceItem } from "../../Models/BizTreasury";
import AppError from "../AppError";
import { currentLocale } from "../i18n/requestContext";
import { BizOwner, ensureChart, ownerFilter } from "./coa";
import { computeVatReturn, depreciationUntil, groupByParty, partyHasTaxIdentity, TaxDoc } from "./accCore";
import { quarterRange } from "./vatReturn";
import { trialBalance, balanceSheet } from "./reports";
import { createInvoice, InvoiceInput, issueInvoice } from "./invoices";
import { createPayment } from "./payments";
import { nextDocNumber } from "./voucher";
import { ownerDoc } from "./finance";

// The rest of Nexxa's accounting pages ported to Noyan (2026-10):
//   tax          the quarterly VAT figures and the ماده‌ی ۱۶۹ seasonal
//                transactions lists (purchases and sales per party id)
//   data-health  the runSystemAudit / runDataHealthChecks invariants
//   price-list   تعرفه‌ی خدمات و کالا, picked by invoices and quick sales
//   proforma     a pre-invoice converted into an invoice
//   quick-invoice one screen: patient, lines, paid now
//   settlements  open invoices with aging, and one receipt spread over them
//   Excel export of any list

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };

// ------------------------------------------------------ seasonal (169)

export const seasonalReport = async (owner: BizOwner, year: number, quarter: number) => {
  const { start, end } = quarterRange(year, quarter);
  const own = ownerFilter(owner);
  const range = { $gte: start, $lte: end };
  const [invoices, expenses, purchases] = await Promise.all([
    BizInvoice.find({ ...own, date: range, status: { $in: ["issued", "partial", "paid"] }, proforma: { $ne: true } }).lean<IBizInvoice[]>(),
    BizExpense.find({ ...own, date: range, isVoid: false, recurring: { $exists: false } }).lean<IBizExpense[]>(),
    BizPurchase.find({ ...own, date: range, status: "received" }).lean<IBizPurchase[]>(),
  ]);
  const supplierIds = [...expenses.map((e) => e.supplier), ...purchases.map((p) => p.supplier)].filter(Boolean);
  const suppliers = new Map((await BizSupplier.find({ _id: { $in: supplierIds } }).lean<IBizSupplier[]>()).map((s) => [String(s._id), s]));
  // the vendor's ids from the party register when the expense only names it
  const vendorNames = [...new Set(expenses.filter((e) => !e.supplier && e.vendor).map((e) => e.vendor!.trim()))];
  const vendorParties = new Map(
    (await BizParty.find({ ...own, kind: "supplier", name: { $in: vendorNames } }).lean<IBizParty[]>()).map((p) => [p.name, p]),
  );
  const sales: TaxDoc[] = invoices.map((i) => ({
    net: (i.subtotal || 0) - (i.discount || 0),
    vat: i.tax || 0,
    party: { name: i.party?.name || "", nationalId: i.party?.nationalId },
  }));
  const purchaseDocs: TaxDoc[] = [
    ...expenses.map((e) => {
      const s = e.supplier ? suppliers.get(String(e.supplier)) : undefined;
      const p = !s && e.vendor ? vendorParties.get(e.vendor.trim()) : undefined;
      return { net: e.amount, vat: e.tax, party: { name: s?.name || e.vendor || "", economicCode: s?.economicCode || p?.economicCode, nationalId: p?.nationalId } };
    }),
    ...purchases.map((p) => {
      const s = suppliers.get(String(p.supplier));
      return { net: (p.subtotal || 0) - (p.discount || 0), vat: p.tax || 0, party: { name: s?.name || "", economicCode: s?.economicCode } };
    }),
  ];
  const salesRows = groupByParty(sales);
  const purchaseRows = groupByParty(purchaseDocs);
  return {
    year,
    quarter,
    start,
    end,
    vat: computeVatReturn(sales, purchaseDocs),
    sales: salesRows.map((r) => ({ ...r, complete: partyHasTaxIdentity(r) })),
    purchases: purchaseRows.map((r) => ({ ...r, complete: partyHasTaxIdentity(r) })),
  };
};

// ------------------------------------------------------- data health

export type HealthCheck = { key: string; module: string; ok: boolean; severity: "error" | "warning"; count: number; total: number };

// The invariants of Nexxa's «کنترل صحت داده» (runDataHealthChecks /
// runSystemAudit) that apply here; each reports how many records break it.
export const dataHealth = async (owner: BizOwner): Promise<HealthCheck[]> => {
  await ensureChart(owner);
  const own = ownerFilter(owner);
  const R: HealthCheck[] = [];
  const add = (key: string, module: string, count: number, total: number, severity: "error" | "warning" = "error") =>
    R.push({ key, module, ok: count === 0, severity, count, total });
  const vouchers = await BizVoucher.find(own).select("lines total state").lean<IBizVoucher[]>();
  const unbalanced = vouchers.filter((v) => Math.abs(v.lines.reduce((s, l) => s + l.debit - l.credit, 0)) > 0.5).length;
  add("balanced", "accounting", unbalanced, vouchers.length);
  const tb = await trialBalance(owner, null, null);
  add("trialZero", "accounting", tb.balanced ? 0 : 1, 1);
  const lines = vouchers.flatMap((v) => v.lines);
  add("oneSided", "accounting", lines.filter((l) => l.debit > 0.01 && l.credit > 0.01).length, lines.length);
  const nonPostable = new Set((await BizAccount.find({ ...own, level: { $ne: "detail" } }).select("code").lean<IBizAccount[]>()).map((a) => a.code));
  add("postable", "accounting", lines.filter((l) => nonPostable.has(l.code)).length, lines.length);
  const codes = new Set((await BizAccount.find(own).select("code").lean<IBizAccount[]>()).map((a) => a.code));
  add("noOrphan", "accounting", lines.filter((l) => !codes.has(l.code)).length, lines.length);
  const sheet = await balanceSheet(owner, null);
  add("sheetBalanced", "accounting", sheet.balanced ? 0 : 1, 1);
  const drafts = await BizVoucher.countDocuments({ ...own, state: "draft" }).setOptions({ withDrafts: true });
  add("drafts", "accounting", drafts, drafts, "warning");
  // a closed year has its three vouchers
  const years = await BizFiscalYear.find(own).lean<{ year: number; vouchers?: { final?: unknown; open?: unknown } }[]>();
  add("yearsClosed", "accounting", years.filter((y) => !y.vouchers?.final && !y.vouchers?.open).length, years.length, "warning");
  if (owner.kind !== "platform" && owner.id) {
    const od = ownerDoc(owner);
    const invoices = await BizInvoice.find({ ...od, origin: "manual", status: { $ne: "draft" } }).select("paid patientShare status").lean<IBizInvoice[]>();
    add("invoiceOver", "sales", invoices.filter((i) => i.paid > i.patientShare + 1).length, invoices.length);
    add("invoicePaid", "sales", invoices.filter((i) => i.status === "paid" && i.paid < i.patientShare - 1).length, invoices.length);
    const payments = await BizPayment.find({ ...od, method: "cheque" }).select("amount").lean<IBizPayment[]>();
    add("chequeNegative", "treasury", payments.filter((p) => p.amount < 0).length, payments.length);
    const expenses = await BizExpense.find({ ...od, isVoid: false, recurring: { $exists: false } }).select("paid total").lean<IBizExpense[]>();
    add("expenseOver", "purchases", expenses.filter((e) => e.paid > e.total + 1).length, expenses.length);
  }
  // fixed assets: accumulated within cost - salvage, the register agrees
  // with what a recomputation gives
  const assets = await BizFixedAsset.find(own).lean<IBizFixedAsset[]>();
  add("assetAccum", "assets", assets.filter((a) => a.accumulatedDep > a.cost - a.salvageValue + 1).length, assets.length);
  const now = new Date();
  add(
    "assetDue",
    "assets",
    assets.filter(
      (a) =>
        a.state === "active" &&
        depreciationUntil(a, now) > 0,
    ).length,
    assets.length,
    "warning",
  );
  return R;
};

// ------------------------------------------------------- price list

export const listPrices = (owner: BizOwner, q: { q?: string; group?: string; all?: boolean }) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (!q.all) filter.isActive = { $ne: false };
  if (q.group) filter.group = q.group;
  if (q.q?.trim()) {
    const r = new RegExp(q.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: r }, { code: r }, { group: r }];
  }
  return BizPriceItem.find(filter).sort({ group: 1, title: 1 }).limit(2000).lean<IBizPriceItem[]>();
};

export const savePrice = async (
  owner: BizOwner,
  d: { id?: string; code?: string; title: string; group?: string; unit?: string; price: number; insurancePrice?: number | null; taxRate?: number; account?: string; isActive?: boolean },
) => {
  const title = (d.title || "").trim().slice(0, 200);
  if (title.length < 2) throw new AppError("عنوان خدمت یا کالا را بنویسید", 400);
  let account: mongoose.Types.ObjectId | undefined;
  if (d.account && mongoose.isValidObjectId(d.account)) {
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: d.account, type: "income", level: "detail" }).lean();
    if (!acc) throw new AppError("حساب درآمد را انتخاب کنید", 400);
    account = acc._id;
  }
  const set = {
    code: d.code?.trim().slice(0, 30) || undefined,
    title,
    group: d.group?.trim().slice(0, 80) || undefined,
    unit: d.unit?.trim().slice(0, 30) || undefined,
    price: Math.max(0, Math.round(Number(d.price) || 0)),
    insurancePrice: d.insurancePrice ? Math.max(0, Math.round(Number(d.insurancePrice))) : undefined,
    taxRate: Math.max(0, Math.min(100, Number(d.taxRate) || 0)),
    account,
    ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
  };
  if (d.id) {
    const doc = await BizPriceItem.findOneAndUpdate({ ...ownerFilter(owner), _id: d.id }, { $set: set }, { new: true }).lean();
    if (!doc) throw new AppError("ردیف تعرفه پیدا نشد", 404);
    return doc;
  }
  return (await BizPriceItem.create({ ...ownerFields(owner), ...set })).toObject();
};

export const deletePrice = async (owner: BizOwner, id: string) => {
  const r = await BizPriceItem.deleteOne({ ...ownerFilter(owner), _id: id });
  if (!r.deletedCount) throw new AppError("ردیف تعرفه پیدا نشد", 404);
};

// --------------------------------------------------- proforma, quick sale

const PROFORMA_BASE = 1_000_000_000;

// A pre-invoice (پیش‌فاکتور): an invoice draft flagged proforma, with its
// own P-numbers; it books nothing.
export const createProforma = async (owner: BizOwner, input: InvoiceInput, by?: unknown) => {
  const seq = await nextDocNumber("proforma", owner);
  const inv = await createInvoice(owner, input, false, by);
  await BizInvoice.updateOne({ _id: (inv as { _id: unknown })._id }, { $set: { proforma: true, proformaNumber: seq, number: PROFORMA_BASE + seq } });
  return BizInvoice.findById((inv as { _id: unknown })._id).lean();
};

export const listProformas = async (owner: BizOwner) =>
  BizInvoice.find({ ...ownerDoc(owner), proforma: true }).sort({ createdAt: -1 }).limit(300).lean<IBizInvoice[]>();

// Nexxa convertProforma: a proforma becomes an invoice with the next
// invoice number - a draft, or issued at once
export const convertProforma = async (owner: BizOwner, id: string, issue: boolean, by?: unknown) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id, proforma: true, status: "draft" });
  if (!inv) throw new AppError("پیش‌فاکتور پیدا نشد", 404);
  const number = await nextDocNumber("invoice", owner);
  inv.set({ proforma: false, number, convertedAt: new Date() });
  await inv.save();
  if (issue) return issueInvoice(owner, String(inv._id), by);
  return inv.toObject();
};

// one screen: the invoice issued and, if paid now, its receipt
export const quickInvoice = async (
  owner: BizOwner,
  d: { invoice: InvoiceInput; pay?: { money: string; method: "cash" | "card" | "transfer"; amount?: number } | null },
  by?: unknown,
) => {
  const inv = (await createInvoice(owner, d.invoice, true, by)) as IBizInvoice;
  let payment = null;
  if (d.pay?.money && inv.patientShare > 0) {
    const amount = Math.min(inv.patientShare, Math.round(Number(d.pay.amount) || inv.patientShare));
    payment = await createPayment(owner, { direction: "in", date: inv.date, amount, method: d.pay.method, money: d.pay.money, against: "invoice", invoice: String(inv._id) }, by);
  }
  return { invoice: await BizInvoice.findById(inv._id).lean(), payment };
};

// ------------------------------------------------------- settlements

const bucket = (days: number) => (days <= 0 ? "current" : days <= 30 ? "d30" : days <= 60 ? "d60" : "older");

// open invoices with their age past due, and what is owed to suppliers
export const settlements = async (owner: BizOwner) => {
  const od = ownerDoc(owner);
  const invoices = await BizInvoice.find({ ...od, origin: "manual", status: { $in: ["issued", "partial"] }, proforma: { $ne: true } })
    .sort({ date: 1 })
    .lean<IBizInvoice[]>();
  const now = Date.now();
  const receivables = invoices
    .map((i) => {
      const remaining = Math.max(0, (i.patientShare || 0) - (i.paid || 0));
      const days = Math.floor((now - new Date(i.dueDate || i.date).getTime()) / 864e5);
      return { _id: i._id, number: i.number, date: i.date, dueDate: i.dueDate, name: i.party?.name || "", phone: i.party?.phone, total: i.patientShare, paid: i.paid, remaining, days, bucket: bucket(days) };
    })
    .filter((r) => r.remaining >= 0.5);
  const payables = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $nin: ["final", "open"] } } },
    { $unwind: "$lines" },
    { $match: { "lines.party": { $exists: true } } },
    { $lookup: { from: BizAccount.collection.name, localField: "lines.account", foreignField: "_id", as: "acc" } },
    { $unwind: "$acc" },
    { $match: { "acc.role": { $in: ["payable", "chequesPayable", "claimsPayable", "doctorsSharePayable"] } } },
    { $group: { _id: "$lines.party", balance: { $sum: { $subtract: ["$lines.credit", "$lines.debit"] } } } },
    { $match: { balance: { $gt: 0.5 } } },
    { $sort: { balance: -1 } },
  ]);
  const parties = new Map((await BizParty.find({ _id: { $in: payables.map((p) => p._id) } }).lean<IBizParty[]>()).map((p) => [String(p._id), p]));
  return {
    receivables,
    totalReceivable: receivables.reduce((s, r) => s + r.remaining, 0),
    overdue: receivables.filter((r) => r.days > 0).length,
    payables: payables.map((p) => ({ _id: String(p._id), name: parties.get(String(p._id))?.name || "", code: parties.get(String(p._id))?.code, balance: Math.round(p.balance) })),
    totalPayable: payables.reduce((s, p) => s + p.balance, 0),
  };
};

// Nexxa recordCustomerReceipt: one receipt spread over several of a
// patient's invoices, oldest first unless amounts are given
export const allocateReceipt = async (
  owner: BizOwner,
  d: { money: string; method: "cash" | "card" | "transfer"; date?: Date; reference?: string; allocations: { invoice: string; amount: number }[] },
  by?: unknown,
) => {
  const allocations = (Array.isArray(d.allocations) ? d.allocations : []).filter((a) => mongoose.isValidObjectId(a.invoice) && Number(a.amount) > 0);
  if (!allocations.length) throw new AppError("مبلغ دریافتی را روی دست‌کم یک صورتحساب بنویسید", 400);
  const out = [];
  for (const a of allocations)
    out.push(
      await createPayment(
        owner,
        { direction: "in", date: d.date || new Date(), amount: Math.round(Number(a.amount)), method: d.method, money: d.money, against: "invoice", invoice: a.invoice, reference: d.reference },
        by,
      ),
    );
  return { payments: out.length, total: allocations.reduce((s, a) => s + Math.round(Number(a.amount)), 0) };
};

// --------------------------------------------------------- Excel export

// any list as an .xlsx sheet (Nexxa ExcelExportButton), right-to-left for
// Persian, Arabic and Urdu; numbers stay numbers
export const toXlsx = async (d: { title?: string; head: string[]; rows: (string | number | null)[][]; rtl?: boolean }) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(d.title || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 30) || "Sheet", { views: [{ rightToLeft: !!d.rtl }] });
  const head = (Array.isArray(d.head) ? d.head : []).slice(0, 60).map((h) => String(h ?? "").slice(0, 200));
  ws.addRow(head).font = { bold: true };
  for (const r of (Array.isArray(d.rows) ? d.rows : []).slice(0, 20000))
    ws.addRow((Array.isArray(r) ? r : []).slice(0, 60).map((c) => (typeof c === "number" ? c : String(c ?? "").slice(0, 2000))));
  ws.columns.forEach((c) => {
    c.width = 18;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
};

// ------------------------------------------------ profile entries

// The everyday entries only one kind of provider has (2026-10, the
// per-profile chart), each one balanced voucher on its profile's accounts:
//   pharmacy  subsidy        Dr 1420 subsidy receivable (insurer) / Cr 6121
//   hospital  doctorShare    Dr 7105 doctors' share / Cr 3305 payable (doctor)
//   clinic    deposit        Dr till or bank / Cr 3306 patient deposits (patient)
//             depositApply   Dr 3306 (patient) / Cr 1411 receivable (patient)
//   insurer   premium        Dr 1411 policyholders (person) / Cr 6106
//             corporate      Dr 1421 corporate contracts (party) / Cr 6126
//             claimIncurred  Dr 7227 claims / Cr 3308 claims payable (provider)
//             claimDeduction Dr 3308 (provider) / Cr 7229 deductions
//             reserve        Dr 7228 / Cr 3309 reserve (release: the other way)
//             providerPay    Dr 3308 (provider) / Cr till or bank
type EntryDef = { kinds: string[]; debit: string | "money"; credit: string | "money"; partyOn?: "debit" | "credit" | "both"; partyKind: string; description: string };
export const PROFILE_ENTRIES: Record<string, EntryDef> = {
  subsidy: { kinds: ["pharmacy"], debit: "subsidyReceivable", credit: "subsidyIncome", partyOn: "debit", partyKind: "insurer", description: "مابه‌التفاوت و یارانه‌ی دارو" },
  doctorShare: { kinds: ["clinic", "hospital"], debit: "doctorsShareExpense", credit: "doctorsSharePayable", partyOn: "credit", partyKind: "doctor", description: "سهم پزشک" },
  deposit: { kinds: ["clinic", "hospital"], debit: "money", credit: "patientDeposits", partyOn: "credit", partyKind: "patient", description: "دریافت ودیعه‌ی بستری" },
  depositApply: { kinds: ["clinic", "hospital"], debit: "patientDeposits", credit: "receivable", partyOn: "both", partyKind: "patient", description: "تسویه‌ی ودیعه با صورتحساب" },
  premium: { kinds: ["insurance"], debit: "receivable", credit: "premiumIncome", partyOn: "debit", partyKind: "person", description: "صدور حق بیمه" },
  corporate: { kinds: ["insurance"], debit: "corporateReceivable", credit: "corporatePremium", partyOn: "debit", partyKind: "custom", description: "حق بیمه‌ی قرارداد سازمانی" },
  claimIncurred: { kinds: ["insurance"], debit: "claimsExpense", credit: "claimsPayable", partyOn: "credit", partyKind: "custom", description: "ثبت خسارت مرکز درمانی" },
  claimDeduction: { kinds: ["insurance"], debit: "claimsPayable", credit: "claimDeductions", partyOn: "debit", partyKind: "custom", description: "کسورات اسناد مرکز درمانی" },
  reserve: { kinds: ["insurance"], debit: "reserveExpense", credit: "claimReserve", partyKind: "custom", description: "ذخیره‌ی خسارت معوق" },
  providerPay: { kinds: ["insurance"], debit: "claimsPayable", credit: "money", partyOn: "debit", partyKind: "custom", description: "پرداخت خسارت به مرکز درمانی" },
};

export const profileEntry = async (
  owner: BizOwner,
  kind: string,
  d: { amount: number; date?: Date; party?: string; partyName?: string; money?: string; description?: string; release?: boolean },
  by?: unknown,
) => {
  const def = PROFILE_ENTRIES[kind];
  if (!def || !def.kinds.includes(owner.kind)) throw new AppError("این نوع ثبت برای این حساب نیست", 400);
  const amount = Math.max(0, Math.round(Number(d.amount) || 0));
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  const { treasuryCredit } = await import("./treasury");
  const { resolveParty } = await import("./parties");
  const party = d.party
    ? await resolveParty(owner, d.party)
    : d.partyName?.trim()
      ? await resolveParty(owner, { kind: def.partyKind as "custom", name: d.partyName.trim() })
      : null;
  if (def.partyOn && !party) throw new AppError("طرف حساب را انتخاب کنید", 400);
  const label = (d.description || def.description).slice(0, 300);
  const side = async (role: string, debit: boolean) => {
    if (role === "money") {
      const m = await treasuryCredit(owner, d.money, debit ? 0 : amount, label, debit);
      return { accountId: m.accountId, label, debit: debit ? amount : 0, credit: debit ? 0 : amount };
    }
    const withParty = def.partyOn === "both" || def.partyOn === (debit ? "debit" : "credit");
    return { role, party: withParty ? party?._id : undefined, label, debit: debit ? amount : 0, credit: debit ? 0 : amount };
  };
  let lines = [await side(def.debit, true), await side(def.credit, false)];
  if (d.release) lines = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
  const seq = await nextDocNumber("profileEntry", owner);
  const { postVoucher } = await import("./voucher");
  return postVoucher(owner, {
    ref: `pe:${kind}:${seq}`,
    date: d.date || new Date(),
    description: d.release ? `${def.description} (آزادسازی)` : def.description,
    source: { type: "profileEntry", id: party?._id || new mongoose.Types.ObjectId() },
    lines,
    createdBy: by,
  });
};

// the profile entries of an owner, newest first
export const listProfileEntries = async (owner: BizOwner) => {
  const items = await BizVoucher.find({ ...ownerFilter(owner), ref: { $regex: "^pe:" } }).sort({ date: -1, number: -1 }).limit(300).lean<IBizVoucher[]>();
  const voided = new Set(items.filter((v) => v.ref?.endsWith(":void")).map((v) => v.ref!.replace(/:void$/, "")));
  return items
    .filter((v) => !v.ref?.endsWith(":void"))
    .map((v) => ({ _id: v._id, number: v.number, date: v.date, kind: v.ref!.split(":")[1], description: v.description, label: v.lines[0]?.label, amount: v.total, void: voided.has(v.ref || "") }));
};

export const voidProfileEntry = async (owner: BizOwner, id: string, by?: unknown) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("سند پیدا نشد", 404);
  const v = await BizVoucher.findOne({ ...ownerFilter(owner), _id: id, ref: { $regex: "^pe:" } }).lean<IBizVoucher>();
  if (!v?.ref) throw new AppError("سند پیدا نشد", 404);
  const { postVoucher } = await import("./voucher");
  return postVoucher(owner, {
    ref: `${v.ref}:void`,
    date: new Date(),
    description: "ابطال ثبت",
    source: v.source,
    lines: v.lines.map((l) => ({ accountId: l.account, party: l.party, label: l.label, debit: l.credit, credit: l.debit })),
    createdBy: by,
  });
};

// Income by the profile's own grouping (2026-10): the profile's income
// accounts (a doctor's visit types, a pharmacy's drug classes, a lab's
// sections), each cost centre (a hospital's wards) and each insurer.
export const profileIncome = async (owner: BizOwner, from: Date | null, to: Date | null) => {
  const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const match = { ...ownerFilter(owner), phase: { $exists: false }, ...(from || to ? { date: range } : {}) };
  const accounts = await BizAccount.find({ ...ownerFilter(owner), type: "income", level: "detail" }).lean<IBizAccount[]>();
  const codes = accounts.map((a) => a.code);
  const [byAccount, byCenter, byInsurer] = await Promise.all([
    BizVoucher.aggregate([{ $match: match }, { $unwind: "$lines" }, { $match: { "lines.code": { $in: codes } } }, { $group: { _id: "$lines.code", net: { $sum: { $subtract: ["$lines.credit", "$lines.debit"] } } } }]),
    BizVoucher.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $match: { "lines.code": { $in: codes } } },
      { $group: { _id: { $ifNull: ["$lines.center", "$center"] }, net: { $sum: { $subtract: ["$lines.credit", "$lines.debit"] } } } },
    ]),
    BizVoucher.aggregate([
      { $match: match },
      { $unwind: "$lines" },
      { $lookup: { from: BizAccount.collection.name, localField: "lines.account", foreignField: "_id", as: "acc" } },
      { $unwind: "$acc" },
      { $match: { "acc.role": { $in: ["insuranceReceivable", "subsidyReceivable"] }, "lines.party": { $exists: true } } },
      { $group: { _id: "$lines.party", billed: { $sum: "$lines.debit" }, received: { $sum: "$lines.credit" } } },
    ]),
  ]);
  const { listCenters } = await import("./analysis");
  const { partyNames } = await import("./parties");
  const { displayName } = await import("./coa");
  const centers = new Map((await listCenters(owner)).map((c) => [String(c._id), c.name]));
  const names = await partyNames(byInsurer.map((b) => b._id));
  return {
    accounts: accounts
      .map((a) => ({ _id: a._id, code: a.code, role: a.role, name: displayName(a, currentLocale()), net: Math.round(byAccount.find((b) => b._id === a.code)?.net || 0) }))
      .filter((r) => r.net),
    centers: byCenter.map((c) => ({ _id: c._id ? String(c._id) : "", name: c._id ? centers.get(String(c._id)) || "" : "", net: Math.round(c.net) })).filter((c) => c.net),
    insurers: byInsurer.map((b) => ({ _id: String(b._id), name: names.get(String(b._id))?.name || "", billed: Math.round(b.billed), received: Math.round(b.received), open: Math.round(b.billed - b.received) })),
  };
};
