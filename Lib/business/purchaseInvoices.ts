import mongoose from "mongoose";
import moment from "moment-jalaali";
import ExcelJS from "exceljs";
import BizPurchaseInvoice, { IBizPurchaseInvoice } from "../../Models/BizPurchaseInvoice";
import BizPurchase, { IBizPurchase } from "../../Models/BizPurchase";
import BizSupplier, { IBizSupplier } from "../../Models/BizSupplier";
import BizAccount from "../../Models/BizAccount";
import BizVoucher from "../../Models/BizVoucher";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { postVoucher } from "./voucher";

// Purchase invoices from the Moadian system (2026-10). The tax
// organisation's API serves the seller (send, inquire), not the buyer, so
// the invoices other sellers registered for this owner come from the
// «صورتحساب‌های خرید» list of the کارپوشه, exported as Excel (or CSV) and
// uploaded here. The columns are found by their Persian names, so a column
// moved or added by the portal does not break the import. Each invoice is
// then paired: with a received purchase of the same supplier (economic
// code), amount and dates when there is exactly one, by hand otherwise, or
// booked as an expense. Amounts arrive in rials and are kept in toman.

const TEHRAN = 210;
const round = (n: number) => Math.round(n * 100) / 100;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });

const latin = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
// for display: Persian letters, the half-space kept
const clean = (s: unknown) =>
  latin(String(s ?? ""))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
// for matching headers and words: the half-space read as a space
const norm = (s: unknown) => clean(s).replace(/‌/g, " ").replace(/\s+/g, " ");

// ------------------------------------------------------------- columns

type Field = "taxId" | "subject" | "sellerName" | "sellerCode" | "date" | "base" | "vat" | "total" | "status";

// the first pattern that matches a header wins; order matters (a header
// that names both the tax and the amount is the tax)
const COLUMNS: { field: Field; test: RegExp; not?: RegExp }[] = [
  { field: "taxId", test: /منحصر|شماره ?(ی )?مالیاتی|شناسه ?(ی )?صورتحساب/ },
  { field: "subject", test: /موضوع/ },
  { field: "sellerCode", test: /(کد|شماره|شناسه).*(اقتصادی|ملی|فروشنده)/, not: /خریدار/ },
  { field: "sellerName", test: /(نام|عنوان).*فروشنده|^فروشنده$/ },
  { field: "date", test: /تاریخ/, not: /ارسال|ثبت|تایید|تأیید|مهلت/ },
  { field: "vat", test: /ارزش ?افزوده|مالیات/, not: /پس از|با احتساب|قبل|بدون|کل|مجموع/ },
  { field: "base", test: /(قبل|بدون|پیش).*(مالیات|ارزش)|پس از (کسر )?تخفیف/ },
  { field: "total", test: /مبلغ ?(کل|نهایی)|جمع ?کل|مجموع|با احتساب/ },
  { field: "status", test: /وضعیت/ },
];

const SUBJECTS: [RegExp, 1 | 2 | 3 | 4][] = [
  [/ابطال/, 3],
  [/برگشت/, 4],
  [/اصلاح/, 2],
  [/اصلی/, 1],
];

type Raw = Record<Field, unknown>;
export type ParsedInvoice = {
  taxId: string;
  subject: 1 | 2 | 3 | 4;
  sellerName?: string;
  sellerCode?: string;
  issuedAt: Date;
  base: number;
  vat: number;
  total: number;
  portalStatus?: string;
  rejected: boolean;
};

const money = (v: unknown) => {
  if (typeof v === "number") return v;
  const s = latin(String(v ?? "")).replace(/[,٬\s]/g, "").replace(/٫/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const dateOf = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = latin(String(v ?? "")).trim();
  const m = /(\d{4})[/\-.]?(\d{1,2})[/\-.]?(\d{1,2})/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // a Jalali date (13xx/14xx) at Tehran midnight, or a Gregorian one
  const t = y < 1700 ? moment.utc(`${y}/${mo}/${d}`, "jYYYY/jM/jD").subtract(TEHRAN, "minutes") : moment.utc(`${y}-${mo}-${d}`, "YYYY-M-D");
  return t.isValid() ? t.toDate() : null;
};

const csvRows = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t" || ch === ";") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
};

const cellValue = (v: ExcelJS.CellValue): unknown => {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return (v as { result?: unknown }).result;
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
    if ("text" in v) return (v as { text: string }).text;
  }
  return v;
};

const sheetRows = async (file: Buffer, name: string): Promise<unknown[][]> => {
  const isZip = file.length > 4 && file[0] === 0x50 && file[1] === 0x4b;
  if (!isZip) {
    if (/\.xls$/i.test(name)) throw new AppError("فایل xls قدیمی خوانده نمی‌شود؛ آن را با فرمت xlsx یا csv ذخیره کنید", 400);
    return csvRows(file.toString("utf8").replace(/^﻿/, ""));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const values = (r.values as ExcelJS.CellValue[]).slice(1).map(cellValue);
    rows.push(values);
  });
  return rows;
};

// the rows of an uploaded file, as invoices; rows that are not invoices
// (totals, blank lines) are skipped and counted
export const parseInvoices = async (file: Buffer, name: string) => {
  const rows = await sheetRows(file, name);
  // the header is the first of the first rows that names the tax id
  let head = -1;
  let map: Partial<Record<Field, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 15) && head < 0; i++) {
    const found: Partial<Record<Field, number>> = {};
    rows[i].forEach((h, col) => {
      const text = norm(h);
      if (!text) return;
      const c = COLUMNS.find((x) => found[x.field] === undefined && x.test.test(text) && !(x.not && x.not.test(text)));
      if (c) found[c.field] = col;
    });
    if (found.taxId !== undefined && found.date !== undefined && (found.total !== undefined || found.base !== undefined)) {
      head = i;
      map = found;
    }
  }
  if (head < 0) throw new AppError("ستون‌های شماره‌ی منحصربه‌فرد مالیاتی، تاریخ و مبلغ در فایل پیدا نشد", 400);
  const invoices: ParsedInvoice[] = [];
  let skipped = 0;
  for (const r of rows.slice(head + 1)) {
    const raw = Object.fromEntries(Object.entries(map).map(([f, col]) => [f, r[col as number]])) as Raw;
    const taxId = norm(raw.taxId).replace(/\s/g, "").toUpperCase();
    const issuedAt = dateOf(raw.date);
    const base = money(raw.base);
    const vat = money(raw.vat);
    const total = money(raw.total);
    if (!/^[A-Z0-9]{10,40}$/.test(taxId) || !issuedAt || (!Number.isFinite(total) && !Number.isFinite(base))) {
      skipped++;
      continue;
    }
    const v = Number.isFinite(vat) ? vat : Number.isFinite(total) && Number.isFinite(base) ? total - base : 0;
    const b = Number.isFinite(base) ? base : total - v;
    const status = norm(raw.status);
    const subjectText = norm(raw.subject);
    invoices.push({
      taxId,
      subject: SUBJECTS.find(([re]) => re.test(subjectText))?.[1] || 1,
      sellerName: clean(raw.sellerName).slice(0, 200) || undefined,
      sellerCode: norm(raw.sellerCode).replace(/\D/g, "").slice(0, 20) || undefined,
      issuedAt,
      base: round(Math.abs(b) / 10),
      vat: round(Math.abs(v) / 10),
      total: round(Math.abs(Number.isFinite(total) ? total : b + v) / 10),
      portalStatus: clean(raw.status).slice(0, 60) || undefined,
      rejected: /رد/.test(status) && !/عدم ?رد/.test(status),
    });
  }
  return { invoices, skipped };
};

// --------------------------------------------------------------- pairing

const digits = (s?: string) => (s || "").replace(/\D/g, "");

// received purchases not paired yet that could be this invoice: the same
// supplier's economic code, the amount within half a percent, two weeks
const candidatesFor = async (owner: BizOwner, inv: Pick<IBizPurchaseInvoice, "sellerCode" | "total" | "issuedAt">, loose = false) => {
  const paired = await BizPurchaseInvoice.find({ ...own(owner), purchase: { $exists: true } }).distinct("purchase");
  const window = (loose ? 60 : 15) * 86400_000;
  const purchases = await BizPurchase.find({
    ...own(owner),
    status: "received",
    _id: { $nin: paired },
    date: { $gte: new Date(inv.issuedAt.getTime() - window), $lte: new Date(inv.issuedAt.getTime() + window) },
  })
    .select("supplier invoiceNo date total tax")
    .sort({ date: -1 })
    .limit(200)
    .lean<Pick<IBizPurchase, "_id" | "supplier" | "invoiceNo" | "date" | "total" | "tax">[]>();
  const suppliers = await BizSupplier.find({ _id: { $in: purchases.map((p) => p.supplier) } })
    .select("name economicCode")
    .lean<Pick<IBizSupplier, "_id" | "name" | "economicCode">[]>();
  const byId = new Map(suppliers.map((s) => [String(s._id), s]));
  const code = digits(inv.sellerCode);
  return purchases
    .map((p) => ({ ...p, supplierName: byId.get(String(p.supplier))?.name || "", supplierCode: digits(byId.get(String(p.supplier))?.economicCode) }))
    .filter((p) => loose || (!!code && p.supplierCode === code && Math.abs(p.total - inv.total) <= Math.max(1, inv.total * 0.005)));
};

// pair every open original or correction that has exactly one candidate
export const autoMatch = async (owner: BizOwner) => {
  const open = await BizPurchaseInvoice.find({ ...own(owner), match: "open", subject: { $in: [1, 2] } }).lean<IBizPurchaseInvoice[]>();
  let matched = 0;
  for (const inv of open) {
    const c = await candidatesFor(owner, inv);
    if (c.length !== 1) continue;
    const done = await BizPurchaseInvoice.updateOne(
      { _id: inv._id, match: "open" },
      { $set: { match: "purchase", purchase: c[0]._id, matchedAt: new Date() } },
    ).catch(() => null);
    if (done?.modifiedCount) matched++;
  }
  return matched;
};

export const importInvoices = async (owner: BizOwner, file: Buffer, name: string, by?: unknown) => {
  const { invoices, skipped } = await parseInvoices(file, name);
  if (!invoices.length) throw new AppError("در این فایل صورتحسابی پیدا نشد", 400);
  let added = 0;
  let updated = 0;
  const seen = new Map(
    (await BizPurchaseInvoice.find({ ...own(owner), taxId: { $in: invoices.map((i) => i.taxId) } }).select("taxId portalStatus rejected").lean<IBizPurchaseInvoice[]>()).map((i) => [i.taxId, i]),
  );
  for (const inv of invoices) {
    const before = seen.get(inv.taxId);
    if (before && before.portalStatus === inv.portalStatus && before.rejected === inv.rejected) continue;
    // a row seen again only refreshes what the portal may have changed
    const res = await BizPurchaseInvoice.updateOne(
      { ...own(owner), taxId: inv.taxId },
      {
        $set: { portalStatus: inv.portalStatus, rejected: inv.rejected },
        $setOnInsert: {
          subject: inv.subject,
          sellerName: inv.sellerName,
          sellerCode: inv.sellerCode,
          issuedAt: inv.issuedAt,
          base: inv.base,
          vat: inv.vat,
          total: inv.total,
          importedAt: new Date(),
          importedBy: by,
          // cancellations and returns need no pairing: they only lower the
          // quarter's credit
          match: inv.subject === 3 || inv.subject === 4 ? "ignored" : "open",
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) added++;
    else updated++;
  }
  const matched = await autoMatch(owner);
  return { rows: invoices.length, added, updated, skipped, matched };
};

// ---------------------------------------------------------------- actions

const load = async (owner: BizOwner, id: unknown) => {
  const inv = await BizPurchaseInvoice.findOne({ ...own(owner), _id: id }).lean<IBizPurchaseInvoice>();
  if (!inv) throw new AppError("صورتحساب خرید پیدا نشد", 404);
  return inv;
};

const REF = (inv: Pick<IBizPurchaseInvoice, "_id">, seq: number) => `pinv:${inv._id}:${seq}`;

export const candidates = async (owner: BizOwner, id: unknown) => {
  const inv = await load(owner, id);
  return candidatesFor(owner, inv, true);
};

export const linkInvoice = async (owner: BizOwner, id: unknown, purchaseId: string) => {
  const inv = await load(owner, id);
  if (inv.match !== "open") throw new AppError("این صورتحساب قبلاً تعیین تکلیف شده است", 400);
  const p = await BizPurchase.findOne({ ...own(owner), _id: purchaseId, status: "received" }).select("_id").lean();
  if (!p) throw new AppError("خرید دریافت‌شده پیدا نشد", 404);
  if (await BizPurchaseInvoice.exists({ ...own(owner), purchase: p._id })) throw new AppError("این خرید به صورتحساب دیگری وصل است", 400);
  await BizPurchaseInvoice.updateOne({ _id: inv._id, match: "open" }, { $set: { match: "purchase", purchase: p._id, matchedAt: new Date() } });
};

// an invoice with no purchase behind it booked as an expense: the expense
// and its VAT against what is owed to the seller
export const expenseInvoice = async (owner: BizOwner, id: unknown, accountId: string, by?: unknown) => {
  const inv = await load(owner, id);
  if (inv.match !== "open") throw new AppError("این صورتحساب قبلاً تعیین تکلیف شده است", 400);
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: accountId }).lean();
  if (!acc || acc.type !== "expense" || acc.level !== "detail") throw new AppError("یک حساب هزینه‌ی معین انتخاب کنید", 400);
  const seq = (inv.seq || 0) + 1;
  const claimed = await BizPurchaseInvoice.updateOne(
    { _id: inv._id, match: "open" },
    { $set: { match: "expense", account: acc._id, seq, matchedAt: new Date() } },
  );
  if (!claimed.modifiedCount) throw new AppError("این صورتحساب قبلاً تعیین تکلیف شده است", 400);
  const base = round(inv.total - inv.vat);
  await postVoucher(owner, {
    ref: REF(inv, seq),
    date: inv.issuedAt,
    description: "هزینه از صورتحساب خرید مودیان",
    source: { type: "purchaseinvoice", id: inv._id },
    lines: [
      { accountId: String(acc._id), debit: base, label: inv.sellerName },
      ...(inv.vat > 0 ? [{ role: "vatReceivable", debit: inv.vat }] : []),
      { role: "payable", credit: inv.total, label: inv.sellerName },
    ],
    createdBy: by,
  });
};

export const ignoreInvoice = async (owner: BizOwner, id: unknown) => {
  const inv = await load(owner, id);
  if (inv.match !== "open") throw new AppError("این صورتحساب قبلاً تعیین تکلیف شده است", 400);
  await BizPurchaseInvoice.updateOne({ _id: inv._id, match: "open" }, { $set: { match: "ignored", matchedAt: new Date() } });
};

// back to open: a pairing is dropped, a booked expense reversed on its day
export const unlinkInvoice = async (owner: BizOwner, id: unknown) => {
  const inv = await load(owner, id);
  if (inv.match === "open") return;
  if (inv.subject === 3 || inv.subject === 4) throw new AppError("ابطال و برگشت جفت‌کردن ندارد", 400);
  const claimed = await BizPurchaseInvoice.updateOne(
    { _id: inv._id, match: inv.match },
    { $set: { match: "open" }, $unset: { purchase: 1, account: 1, matchedAt: 1 } },
  );
  if (!claimed.modifiedCount) throw new AppError("این صورتحساب هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  if (inv.match === "expense") {
    const ref = REF(inv, inv.seq);
    const original = await BizVoucher.findOne({ ...ownerFilter(owner), ref }).lean<{ date: Date; lines: { account: unknown; debit: number; credit: number }[] }>();
    if (original?.lines?.length)
      await postVoucher(owner, {
        ref: `${ref}:rev`,
        date: original.date,
        description: "برگشت هزینه‌ی صورتحساب خرید",
        source: { type: "purchaseinvoice", id: inv._id },
        lines: original.lines.map((l) => ({ accountId: String(l.account), debit: l.credit, credit: l.debit })),
      });
  }
};

export const listInvoices = async (owner: BizOwner, q: { match?: string; from?: Date | null; to?: Date | null; page: number; limit: number }) => {
  const filter: Record<string, unknown> = { ...own(owner) };
  if (q.match) filter.match = q.match;
  if (q.from || q.to) filter.issuedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [rows, total, counts] = await Promise.all([
    BizPurchaseInvoice.find(filter)
      .sort({ issuedAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate({ path: "purchase", select: "invoiceNo date total supplier", populate: { path: "supplier", select: "name" } })
      .populate({ path: "account", select: "code name" })
      .lean(),
    BizPurchaseInvoice.countDocuments(filter),
    BizPurchaseInvoice.aggregate([{ $match: own(owner) }, { $group: { _id: "$match", n: { $sum: 1 } } }]),
  ]);
  return { rows, total, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
};

// ------------------------------------------------------- for the VAT return

// the quarter's VAT credit from Moadian: paired, not rejected invoices;
// cancellations and returns take theirs off. null when nothing was imported
// for the quarter (the economic-code rule then applies)
export const moadianCredit = async (owner: BizOwner, start: Date, end: Date) => {
  const list = await BizPurchaseInvoice.find({ ...own(owner), issuedAt: { $gte: start, $lte: end } })
    .select("subject vat match rejected purchase")
    .lean<Pick<IBizPurchaseInvoice, "subject" | "vat" | "match" | "rejected" | "purchase">[]>();
  if (!list.length) return null;
  const creditable = (i: (typeof list)[number]) => !i.rejected && (i.match === "purchase" || i.match === "expense");
  const sign = (i: (typeof list)[number]) => (i.subject === 3 || i.subject === 4 ? -1 : 1);
  return {
    count: list.length,
    open: list.filter((i) => i.match === "open").length,
    rejected: list.filter((i) => i.rejected).length,
    // purchases whose VAT is creditable because a Moadian invoice backs them
    // (the invoice may carry a date in a neighbouring quarter)
    purchases: new Set(
      (await BizPurchaseInvoice.find({ ...own(owner), match: "purchase", rejected: false, purchase: { $exists: true } }).distinct("purchase")).map(String),
    ),
    reductions: round(list.filter((i) => sign(i) < 0 && !i.rejected).reduce((s, i) => s + i.vat, 0)),
    vat: round(list.filter((i) => sign(i) > 0 && creditable(i)).reduce((s, i) => s + i.vat, 0)),
  };
};
