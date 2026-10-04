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
import { BizOwner, ensureChart, ownerFilter } from "./coa";
import { computeVatReturn, depreciationForMonths, groupByParty, partyHasTaxIdentity, TaxDoc, wholeMonths } from "./accCore";
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
        depreciationForMonths({ ...a, decliningRate: a.decliningRate || 0 }, wholeMonths(a.lastDepDate ?? a.acquisitionDate, now)) > 0,
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
    { $match: { "acc.role": { $in: ["payable", "chequesPayable"] } } },
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
