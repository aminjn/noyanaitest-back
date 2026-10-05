import crypto from "crypto";
import mongoose from "mongoose";
import BizInvoice, { BizInsurerKind, IBizInvoice, IBizInvoiceLine } from "../../Models/BizInvoice";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizPayment from "../../Models/BizPayment";
import BizItem, { IBizItem } from "../../Models/BizItem";
import { returnInvoiceLines, sellInvoiceLines } from "./inventory";
import Transaction, { ITransaction } from "../../Models/Transaction";
import Reservation from "../../Models/Reservation";
import Order from "../../Models/Order";
import AppError from "../AppError";
import { sendSMS } from "../sendSms";
import { getAppConfig } from "../appConfig";
import { invoiceManual } from "../moadian/issue";
import { MoadianItemKind } from "../../Models/MoadianProfile";
import { accountFor, BizOwner, ownerFilter } from "./coa";
import { nextDocNumber, PostLine } from "./voucher";
import { assertOpen, defaultIncomeRole, oid, ownerDoc, postDoc, reverseRef, toman } from "./finance";
import { orgInfo } from "./campaign";

// Patient invoices (2026-10, «صورتحساب‌ها»), after Practo Ray's and Doctolib
// Pro's billing: every paid visit and order on Noyan is an invoice already
// (written here from the transaction, paid by the wallet, already in the
// books), and the provider types the rest - the in-person visit paid at the
// desk, the procedure, the counter sale - with line items, discount and
// VAT, the insurer's share, a print view and a link sent by SMS. Issuing a
// manual invoice books:
//
//   Dr 1411 receivable (patient's share) + 1412 insurers (insurer's share)
//   Cr the income account of each line (net of discount) + 3307 VAT
//
// and payments (Lib/business/payments.ts) clear the patient's share.

export type InvoiceLineInput = { title: string; qty?: number; unitPrice: number; discount?: number; taxRate?: number; account?: string; item?: string };
export type InvoiceInput = {
  date: Date;
  dueDate?: Date | null;
  party: { name: string; phone?: string; nationalId?: string };
  doctorName?: string;
  lines: InvoiceLineInput[];
  insurer?: { kind: BizInsurerKind; name: string; share: number } | null;
  note?: string;
  center?: string;
};

const SESSION_TITLES: Record<string, string> = {
  inPerson: "ویزیت حضوری",
  textChat: "مشاوره‌ی پزشکی متنی",
  sipCall: "مشاوره‌ی پزشکی تلفنی",
  voiceCall: "مشاوره‌ی پزشکی صوتی",
  videoCall: "مشاوره‌ی پزشکی تصویری",
  phone: "مشاوره‌ی پزشکی تلفنی",
};

const newToken = () => crypto.randomBytes(9).toString("base64url");

// the lines with their net and tax, and the invoice's totals
const priced = async (owner: BizOwner, input: InvoiceLineInput[]) => {
  if (!Array.isArray(input) || !input.length) throw new AppError("دست‌کم یک ردیف به صورتحساب اضافه کنید", 400);
  const fallback = await accountFor(owner, defaultIncomeRole(owner.kind));
  const ids = input.map((l) => l.account).filter((a): a is string => !!a && mongoose.isValidObjectId(a));
  const accounts = new Map(
    (await BizAccount.find({ ...ownerFilter(owner), _id: { $in: ids }, type: "income", level: "detail" }).lean<IBizAccount[]>()).map((a) => [String(a._id), a]),
  );
  // (2026-10) a line may sell a stock item of this owner (the counter
  // sale); a pharmacy's line without an account goes to its class's income
  const itemIds = input.map((l) => l.item).filter((a): a is string => !!a && mongoose.isValidObjectId(a));
  const items = new Map(
    (itemIds.length ? await BizItem.find({ ...ownerDoc(owner), _id: { $in: itemIds } }).select("kind itemClass").lean<IBizItem[]>() : []).map((i) => [String(i._id), i]),
  );
  const classIncome = new Map<string, IBizAccount>();
  if (owner.kind === "pharmacy")
    for (const it of items.values()) {
      const role = it.kind === "supply" ? "suppliesIncome" : it.itemClass === "otc" ? "otcIncome" : it.itemClass === "cosmetic" ? "cosmeticIncome" : "salesIncome";
      if (!classIncome.has(String(it._id))) classIncome.set(String(it._id), await accountFor(owner, role));
    }
  const lines: IBizInvoiceLine[] = input.map((l) => {
    const qty = Math.max(0, Number(l.qty ?? 1) || 0);
    const unitPrice = toman(l.unitPrice);
    const gross = Math.round(qty * unitPrice);
    const discount = Math.min(gross, toman(l.discount));
    const taxRate = Math.min(100, Math.max(0, Number(l.taxRate) || 0));
    const net = gross - discount;
    const item = l.item ? items.get(l.item) : undefined;
    const acc = (l.account && accounts.get(l.account)) || (item && classIncome.get(String(item._id))) || fallback;
    return {
      title: String(l.title || "").trim().slice(0, 300) || "خدمت",
      qty,
      unitPrice,
      discount,
      taxRate,
      account: acc._id,
      net,
      tax: Math.round((net * taxRate) / 100),
      ...(item ? { item: item._id } : {}),
    } as IBizInvoiceLine;
  });
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  const tax = lines.reduce((s, l) => s + l.tax, 0);
  const total = lines.reduce((s, l) => s + l.net + l.tax, 0);
  return { lines, subtotal, discount, tax, total };
};

const fields = async (owner: BizOwner, input: InvoiceInput) => {
  const p = await priced(owner, input.lines);
  const share = input.insurer ? Math.min(p.total, toman(input.insurer.share)) : 0;
  if (share > 0 && owner.kind === "insurance") throw new AppError("سهم بیمه برای این حساب معنا ندارد", 400);
  return {
    ...p,
    date: input.date,
    dueDate: input.dueDate || undefined,
    party: {
      name: (input.party?.name || "").trim().slice(0, 200),
      phone: (input.party?.phone || "").replace(/[^\d+]/g, "").slice(0, 20) || undefined,
      nationalId: (input.party?.nationalId || "").replace(/\D/g, "").slice(0, 10) || undefined,
    },
    doctorName: input.doctorName?.trim().slice(0, 200) || undefined,
    insurer: share > 0 && input.insurer ? { kind: input.insurer.kind, name: input.insurer.name.trim().slice(0, 120), share } : undefined,
    patientShare: p.total - share,
    note: input.note?.trim().slice(0, 1000) || undefined,
    center: input.center && mongoose.isValidObjectId(input.center) ? oid(input.center) : undefined,
  };
};

export const createInvoice = async (owner: BizOwner, input: InvoiceInput, issue: boolean, by?: unknown) => {
  const f = await fields(owner, input);
  if (!f.party.name) throw new AppError("نام بیمار یا خریدار را بنویسید", 400);
  if (issue) await assertOpen(owner, f.date);
  const number = await nextDocNumber("invoice", owner);
  const inv = await BizInvoice.create({ ...ownerDoc(owner), number, origin: "manual", status: "draft", token: newToken(), ...f, createdBy: by });
  if (issue) return issueInvoice(owner, String(inv._id), by);
  return inv.toObject();
};

export const updateInvoice = async (owner: BizOwner, id: string, input: InvoiceInput) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id });
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  if (inv.status !== "draft") throw new AppError("فقط پیش‌نویس ویرایش می‌شود؛ صورتحساب صادرشده را باطل و دوباره صادر کنید", 400);
  Object.assign(inv, await fields(owner, input));
  if (!inv.insurer) inv.set("insurer", undefined);
  await inv.save();
  return inv.toObject();
};

export const deleteDraft = async (owner: BizOwner, id: string) => {
  const r = await BizInvoice.deleteOne({ ...ownerDoc(owner), _id: id, status: "draft" });
  if (!r.deletedCount) throw new AppError("فقط پیش‌نویس حذف می‌شود", 400);
};

export const issueInvoice = async (owner: BizOwner, id: string, by?: unknown) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id });
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  if (inv.status !== "draft") throw new AppError("این صورتحساب قبلاً صادر شده است", 400);
  if (inv.total <= 0) throw new AppError("مبلغ صورتحساب صفر است", 400);
  await assertOpen(owner, inv.date);
  const label = `${inv.party?.name || ""} · #${inv.number}`;
  const income = new Map<string, number>();
  for (const l of inv.lines) income.set(String(l.account), (income.get(String(l.account)) || 0) + l.net);
  const lines: PostLine[] = [
    { role: "receivable", debit: inv.patientShare, credit: 0, label },
    {
      role: "insuranceReceivable",
      debit: inv.insurer?.share || 0,
      credit: 0,
      label: inv.insurer ? `${inv.insurer.name} · ${label}` : label,
      party: inv.insurer?.name ? { kind: "insurer" as const, name: inv.insurer.name } : undefined,
    },
    ...[...income.entries()].map(([accountId, net]) => ({ accountId, debit: 0, credit: net, label })),
    { role: "vatPayable", debit: 0, credit: inv.tax, label },
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  await postDoc(owner, {
    ref: `inv:${inv._id}`,
    date: inv.date,
    description: "صدور صورتحساب بیمار",
    lines,
    source: { type: "invoice", id: inv._id },
    center: inv.center,
    createdBy: by,
    // the patient's own ledger (تفصیلی)
    party: inv.party?.name ? { kind: "patient", name: inv.party.name, phone: inv.party.phone, nationalId: inv.party.nationalId } : undefined,
  });
  inv.status = inv.patientShare <= 0 ? "paid" : "issued";
  inv.issuedAt = new Date();
  await inv.save();
  // the items sold leave stock with their cost of sales
  await sellInvoiceLines(owner, inv.toObject(), by);
  return inv.toObject();
};

export const voidInvoice = async (owner: BizOwner, id: string, reason: string) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id });
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  if (inv.origin !== "manual") throw new AppError("صورتحساب نوبت‌ها و سفارش‌های نویان از همان نوبت یا سفارش برگشت می‌خورد", 400);
  if (inv.status === "void" || inv.status === "draft") throw new AppError("این صورتحساب صادر نشده است", 400);
  if (await BizPayment.exists({ ...ownerDoc(owner), invoice: inv._id, isVoid: false }))
    throw new AppError("ابتدا دریافت‌های این صورتحساب را باطل کنید", 400);
  if (inv.claim) throw new AppError("این صورتحساب در یک لیست بیمه است؛ ابتدا آن را از لیست بردارید", 400);
  await assertOpen(owner, new Date());
  await reverseRef(owner, `inv:${inv._id}`, "ابطال صورتحساب بیمار");
  // and the items sold come back into stock
  await returnInvoiceLines(owner, inv.toObject());
  inv.status = "void";
  inv.voidedAt = new Date();
  inv.voidReason = reason.slice(0, 500);
  await inv.save();
  return inv.toObject();
};

// ---------------------------------------------------- from the platform

const ORG_FIELD: Record<string, string> = {
  doctor: "doctor",
  clinic: "clinic",
  hospital: "hospital",
  pharmacy: "pharmacy",
  paraClinic: "paraClinic",
  insurance: "insurance",
};

const personName = (idn?: { givenName?: string; lastName?: string } | null) =>
  idn ? `${idn.givenName || ""} ${idn.lastName || ""}`.trim() : "";

const lastSync = new Map<string, number>();

// Every earning transaction of the owner (a paid visit, a fulfilled order
// line) not yet on an invoice gets one: a visit is its own invoice, an
// order's lines gather on the order's. Runs before a listing, at most once
// a minute per owner; idempotent by the invoice ref and the line's tx.
export const syncPlatformInvoices = async (owner: BizOwner, force = false) => {
  const field = ORG_FIELD[owner.kind];
  if (!field || !owner.id) return;
  const key = `${owner.kind}:${owner.id}`;
  if (!force && Date.now() - (lastSync.get(key) || 0) < 60_000) return;
  lastSync.set(key, Date.now());
  const own = ownerDoc(owner);
  const latest = await BizInvoice.findOne({ ...own, origin: "platform" }).sort({ date: -1 }).select("date").lean<{ date: Date }>();
  // a margin: an order's later lines arrive after its first
  const since = latest ? new Date(latest.date.getTime() - 30 * 864e5) : new Date(0);
  const txs = await Transaction.find({
    [field]: own.ownerId,
    amount: { $gt: 0 },
    adminAction: { $exists: false },
    createdAt: { $gte: since },
    $or: [{ reservation: { $exists: true, $ne: null } }, { order: { $exists: true, $ne: null } }],
  })
    .sort({ createdAt: 1 })
    .limit(1000)
    .lean<ITransaction[]>();
  if (!txs.length) return;
  const done = new Set(
    (
      await BizInvoice.find({ ...own, origin: "platform", "lines.tx": { $in: txs.map((t) => t._id) } })
        .select("lines.tx")
        .lean<{ lines: { tx?: unknown }[] }[]>()
    ).flatMap((i) => i.lines.map((l) => String(l.tx))),
  );
  const incomeAcc = async (role: string) => (await accountFor(owner, role).catch(() => accountFor(owner, defaultIncomeRole(owner.kind))))._id;
  for (const t of txs) {
    if (done.has(String(t._id))) continue;
    const amount = Number(t.amount) || 0;
    const sellerTax = typeof t.tax === "number" ? Math.max(0, t.tax) : 0;
    const gross = Math.max(amount - sellerTax, Number(t.grossAmount) || amount - sellerTax + (Number(t.commission) || 0));
    try {
      if (t.reservation) {
        const r = await Reservation.findById(t.reservation)
          .select("sessionType tax patient doctor")
          .populate({ path: "patient", select: "givenName lastName" })
          .populate({ path: "doctor", select: "firstName lastName" })
          .lean<Record<string, any>>();
        const tax = sellerTax || Math.max(0, Number(r?.tax) || 0);
        const line = {
          title: SESSION_TITLES[r?.sessionType] || "ویزیت پزشک",
          qty: 1,
          unitPrice: gross,
          discount: 0,
          taxRate: gross ? Math.round((tax / gross) * 100) : 0,
          account: await incomeAcc("visitIncome"),
          net: gross,
          tax,
          tx: t._id,
        };
        await BizInvoice.create({
          ...own,
          number: await nextDocNumber("invoice", owner),
          origin: "platform",
          ref: `res:${t.reservation}`,
          date: t.createdAt,
          party: { name: personName(r?.patient) },
          doctorName: owner.kind !== "doctor" && r?.doctor ? `${r.doctor.firstName || ""} ${r.doctor.lastName || ""}`.trim() : undefined,
          lines: [line],
          subtotal: gross,
          discount: 0,
          tax,
          total: gross + tax,
          patientShare: gross + tax,
          paid: gross + tax,
          status: "paid",
          issuedAt: t.createdAt,
          token: newToken(),
          source: { type: "reservation", id: t.reservation },
        }).catch((err) => {
          if (err?.code !== 11000) throw err;
        });
        continue;
      }
      const order = await Order.findById(t.order)
        .populate({ path: "user", select: "identity", populate: { path: "identity", select: "givenName lastName" } })
        .populate({ path: "products.item", select: "product", populate: { path: "product", select: "name" } })
        .populate({ path: "productPackages.item", select: "name" })
        .populate({ path: "services.item", select: "name" })
        .populate({ path: "servicePackages.item", select: "name" })
        .populate({ path: "tests.item", select: "test", populate: { path: "test", select: "name" } })
        .lean<Record<string, any>>();
      if (!order) continue;
      const lineId = String(t.orderItem || "");
      let title = "هزینه‌ی ارسال سفارش";
      let role = "shippingIncome";
      let qty = 1;
      for (const [f, r, name] of [
        ["products", "salesIncome", (l: any) => l.item?.product?.name],
        ["productPackages", "salesIncome", (l: any) => l.item?.name],
        ["services", "serviceIncome", (l: any) => l.item?.name],
        ["servicePackages", "serviceIncome", (l: any) => l.item?.name],
        ["tests", "testIncome", (l: any) => l.item?.test?.name],
      ] as const) {
        const l = (Array.isArray(order[f]) ? order[f] : []).find((x: any) => String(x?._id) === lineId);
        if (l) {
          title = name(l) || "قلم سفارش";
          role = r;
          qty = Math.max(1, Number(l.qty) || 1);
          break;
        }
      }
      const tax = sellerTax;
      const line = {
        title,
        qty,
        unitPrice: Math.round(gross / qty),
        discount: 0,
        taxRate: gross ? Math.round((tax / gross) * 100) : 0,
        account: await incomeAcc(role),
        net: gross,
        tax,
        tx: t._id,
      };
      const ref = `order:${t.order}`;
      const existing = await BizInvoice.findOne({ ...own, ref });
      if (existing) {
        existing.lines.push(line as IBizInvoiceLine);
        existing.subtotal += gross;
        existing.tax += tax;
        existing.total += gross + tax;
        existing.patientShare += gross + tax;
        existing.paid += gross + tax;
        await existing.save();
      } else
        await BizInvoice.create({
          ...own,
          number: await nextDocNumber("invoice", owner),
          origin: "platform",
          ref,
          date: t.createdAt,
          party: { name: personName(order.user?.identity) },
          lines: [line],
          subtotal: gross,
          discount: 0,
          tax,
          total: gross + tax,
          patientShare: gross + tax,
          paid: gross + tax,
          status: "paid",
          issuedAt: t.createdAt,
          token: newToken(),
          source: { type: "order", id: t.order },
        }).catch((err) => {
          if (err?.code !== 11000) throw err;
        });
    } catch (err) {
      console.log(`[finance] invoice for transaction ${t._id} failed:`, err);
    }
  }
};

export const listInvoices = async (
  owner: BizOwner,
  q: { status?: string; origin?: string; from?: Date | null; to?: Date | null; search?: string; page: number; limit: number },
) => {
  await syncPlatformInvoices(owner);
  // pre-invoices live on their own page (Lib/business/accExtras.ts)
  const filter: Record<string, unknown> = { ...ownerDoc(owner), proforma: { $ne: true } };
  if (q.status === "open") filter.status = { $in: ["issued", "partial"] };
  else if (q.status) filter.status = q.status;
  if (q.origin) filter.origin = q.origin;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.search) {
    const s = q.search.trim();
    const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ "party.name": rx }, { "party.phone": rx }, { doctorName: rx }, ...(/^\d+$/.test(s) ? [{ number: Number(s) }] : [])];
  }
  const [items, total, sums] = await Promise.all([
    BizInvoice.find(filter).sort({ date: -1, number: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).select("-token").lean(),
    BizInvoice.countDocuments(filter),
    BizInvoice.aggregate([
      { $match: { ...filter, status: { $nin: ["void", "draft"] } } },
      { $group: { _id: null, total: { $sum: "$total" }, paid: { $sum: "$paid" }, due: { $sum: { $subtract: ["$patientShare", "$paid"] } } } },
    ]),
  ]);
  return { items, total, sums: sums[0] || { total: 0, paid: 0, due: 0 } };
};

export const getInvoice = async (owner: BizOwner, id: string) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id })
    .populate({ path: "lines.account", select: "code name" })
    .populate({ path: "claim", select: "number status insurer" })
    .populate({ path: "moadian", select: "taxId status" })
    .lean();
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  const payments = await BizPayment.find({ ...ownerDoc(owner), invoice: inv._id }).sort({ date: 1 }).populate({ path: "money", select: "name kind" }).lean();
  return { ...inv, payments };
};

// ---------------------------------------------------------- link & SMS

const siteBase = async () => ((await getAppConfig()).siteBaseUrl || "").replace(/\/+$/, "");

export const invoiceLink = async (inv: Pick<IBizInvoice, "token">) => `${await siteBase()}/i/${inv.token}`;

// The invoice's link to the patient by SMS (pattern INVOICE_LINK_PATTERN,
// variables center, amount, link). Without a pattern the admin left empty,
// nothing is sent and the link is still shown to copy.
export const smsInvoice = async (owner: BizOwner, id: string, phone?: string) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id });
  if (!inv || inv.status === "draft" || inv.status === "void") throw new AppError("صورتحساب صادرشده پیدا نشد", 404);
  const to = (phone || inv.party?.phone || "").replace(/\D/g, "");
  if (!/^(98|0)?9\d{9}$/.test(to)) throw new AppError("شماره‌ی موبایل بیمار را وارد کنید", 400);
  const mobile = `98${to.slice(-10)}`;
  const { name } = await orgInfo(owner).catch(() => ({ name: "" }));
  const link = await invoiceLink(inv);
  // what is still to pay, or the invoice's total once it is settled
  const due = inv.patientShare - inv.paid;
  const sent = await sendSMS(mobile, { center: name, amount: toman(due > 0 ? due : inv.total).toLocaleString("en-US"), link }, "INVOICE_LINK_PATTERN");
  if (!inv.party.phone) inv.party.phone = mobile;
  if (sent) inv.smsSentAt = new Date();
  await inv.save();
  return { sent, link };
};

// what a patient sees at /i/<token>: no sign-in, nothing but this invoice
export const publicInvoice = async (token: string) => {
  if (!/^[A-Za-z0-9_-]{8,20}$/.test(token)) return null;
  const inv = await BizInvoice.findOne({ token, status: { $nin: ["draft"] } }).lean<IBizInvoice>();
  if (!inv) return null;
  const owner = { kind: inv.ownerKind, id: String(inv.ownerId) } as BizOwner;
  const { name } = await orgInfo(owner).catch(() => ({ name: "" }));
  return {
    seller: name,
    number: inv.number,
    date: inv.date,
    dueDate: inv.dueDate,
    party: { name: inv.party?.name },
    doctorName: inv.doctorName,
    lines: inv.lines.map((l) => ({ title: l.title, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, tax: l.tax, net: l.net })),
    subtotal: inv.subtotal,
    discount: inv.discount,
    tax: inv.tax,
    total: inv.total,
    insurer: inv.insurer ? { name: inv.insurer.name, share: inv.insurer.share } : undefined,
    patientShare: inv.patientShare,
    paid: inv.paid,
    status: inv.status,
  };
};

// ------------------------------------------------------------- Moadian

const MOADIAN_KIND: Record<string, MoadianItemKind> = {
  visitIncome: "visit",
  serviceIncome: "service",
  testIncome: "test",
  salesIncome: "product",
  shippingIncome: "shipping",
};

export const sendInvoiceToMoadian = async (owner: BizOwner, id: string) => {
  const inv = await BizInvoice.findOne({ ...ownerDoc(owner), _id: id });
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  if (inv.origin !== "manual") throw new AppError("صورتحساب نوبت‌ها و سفارش‌های نویان خودکار به مودیان می‌رود", 400);
  if (inv.status === "draft" || inv.status === "void") throw new AppError("فقط صورتحساب صادرشده به مودیان می‌رود", 400);
  const roles = new Map(
    (await BizAccount.find({ _id: { $in: inv.lines.map((l) => l.account) } }).select("role").lean<{ _id: unknown; role?: string }[]>()).map((a) => [String(a._id), a.role || ""]),
  );
  const m = await invoiceManual(owner, {
    ref: `inv:${inv._id}`,
    issuedAt: inv.issuedAt || inv.date,
    party: inv.party?.name,
    nationalId: inv.party?.nationalId,
    lines: inv.lines.map((l) => ({
      title: l.title,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: l.discount,
      tax: l.tax,
      kind: MOADIAN_KIND[roles.get(String(l.account)) || ""] || "service",
    })),
  });
  inv.moadian = oid(m._id);
  await inv.save();
  return m;
};
