import crypto from "crypto";
import { tomanToRial } from "../currency";
import mongoose from "mongoose";
import moment from "moment-jalaali";
import MoadianProfile, { IMoadianProfile, MoadianItemKind } from "../../Models/MoadianProfile";
import MoadianInvoice, { IMoadianBuyer, IMoadianInvoice, IMoadianItem, MoadianSource } from "../../Models/MoadianInvoice";
import Transaction, { ITransaction } from "../../Models/Transaction";
import Reservation from "../../Models/Reservation";
import Order from "../../Models/Order";
import BizCampaign from "../../Models/BizCampaign";
import BaseDoctorLicense from "../../Models/BaseDoctorLicense";
import BasePharmacyLicense from "../../Models/BasePharmacyLicense";
import BaseClinicLicense from "../../Models/BaseClinicLicense";
import BaseHospitalLicense from "../../Models/BaseHospitalLicense";
import BaseParaClinicLicense from "../../Models/BaseParaClinicLicense";
import BaseInsuranceLicense from "../../Models/BaseInsuranceLicense";
import { BizOwnerKind } from "../../Models/BizAccount";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "../business/coa";
import { orgInfo } from "../business/campaign";
import { innoOf, makeTaxId } from "./taxid";
import { inquire, MoadianCreds, sendInvoices } from "./client";

// Noyan Business phase 5 (2026-10): electronic invoices for the Moadian
// system (سامانه‌ی مودیان), docs/business-suite.md. Like the books
// (Lib/business/ledgerPoster.ts), invoices come from the one money ledger,
// Transaction, so nothing is typed twice:
//   - a provider's earning (a visit, a fulfilled order line, its shipping)
//     is the provider's sale to the patient: a type-2 invoice (final
//     consumer, no buyer identity) unless the buyer asks for one in their
//     name - then the provider turns it into type 1 (cancel and re-issue);
//   - an accepted dispute (payoutReversal) is a return of that sale;
//   - Noyan's own services are Noyan's invoices to the provider: a plan
//     bought, a finished SMS campaign's net cost, and once a month the
//     platform commission of the month before - type 1 when the provider's
//     own Moadian settings carry its national id or economic code.
// Only taxpayers whose Moadian link is active are invoiced, from the moment
// it was switched on. Invoices go out on their own a minute later, signed
// with the taxpayer's own key; their outcome is asked shortly after.

const PLATFORM: BizOwner = { kind: "platform" };
const ORG_FIELDS: [keyof ITransaction, Exclude<BizOwnerKind, "platform">][] = [
  ["doctor", "doctor"],
  ["pharmacy", "pharmacy"],
  ["clinic", "clinic"],
  ["paraClinic", "paraClinic"],
  ["hospital", "hospital"],
  ["insurance", "insurance"],
];
const LICENSE_FIELDS: [string, mongoose.Model<any>][] = [
  ["license", BaseDoctorLicense],
  ["pharmacyLicense", BasePharmacyLicense],
  ["clinicLicense", BaseClinicLicense],
  ["paraClinicLicense", BaseParaClinicLicense],
  ["hospitalLicense", BaseHospitalLicense],
  ["insuranceLicense", BaseInsuranceLicense],
];
const SESSION_TITLES: Record<string, string> = {
  inPerson: "ویزیت حضوری",
  textChat: "مشاوره‌ی پزشکی متنی",
  sipCall: "مشاوره‌ی پزشکی تلفنی",
  voiceCall: "مشاوره‌ی پزشکی صوتی",
  videoCall: "مشاوره‌ی پزشکی تصویری",
  phone: "مشاوره‌ی پزشکی تلفنی",
};
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const oid = (v: unknown) => new mongoose.Types.ObjectId(idOf(v));

export const orgOfTx = (t: ITransaction): BizOwner | null => {
  for (const [field, kind] of ORG_FIELDS) if (t[field]) return { kind, id: idOf(t[field]) };
  return null;
};

const ownerOfDoc = (d: { ownerKind: BizOwnerKind; ownerId?: unknown }): BizOwner =>
  d.ownerKind === "platform" ? PLATFORM : { kind: d.ownerKind, id: idOf(d.ownerId) };

const ownerFields = (o: BizOwner) => (o.kind === "platform" || !o.id ? { ownerKind: o.kind } : { ownerKind: o.kind, ownerId: oid(o.id) });

// ------------------------------------------------------------- profiles

export const readyProblems = (p: Pick<IMoadianProfile, "memoryId" | "economicCode" | "publicKey"> & { privateKey?: string }) => {
  const out: string[] = [];
  if (!p.privateKey && !p.publicKey) out.push("ابتدا کلید را بسازید");
  if (!p.memoryId) out.push("شناسه‌ی یکتای حافظه‌ی مالیاتی را وارد کنید");
  if (!p.economicCode) out.push("کد ملی یا شناسه‌ی ملی یا کد اقتصادی را وارد کنید");
  return out;
};

const activeCache = new Map<string, { at: number; p: (IMoadianProfile & { privateKey?: string }) | null }>();
export const clearMoadianCache = () => activeCache.clear();

const activeProfile = async (o: BizOwner) => {
  const key = `${o.kind}:${o.id || ""}`;
  const hit = activeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = await MoadianProfile.findOne({ ...ownerFilter(o), isActive: true })
    .select("+privateKey")
    .lean<IMoadianProfile & { privateKey?: string }>();
  const ok = p && !readyProblems(p).length && p.privateKey ? p : null;
  activeCache.set(key, { at: Date.now(), p: ok });
  return ok;
};

const credsOf = (p: IMoadianProfile & { privateKey?: string }): MoadianCreds => ({
  env: p.env,
  memoryId: String(p.memoryId),
  privateKey: String(p.privateKey),
  certificate: p.certificate,
});

// a provider as the buyer of Noyan's services: its own Moadian identity
const buyerOfOrg = async (o: BizOwner, name: string): Promise<IMoadianBuyer | undefined> => {
  const p = await MoadianProfile.findOne(ownerFilter(o)).select("taxpayerType economicCode postalCode name").lean<IMoadianProfile>();
  if (!p?.economicCode) return undefined;
  const natural = p.taxpayerType !== "legal";
  return {
    type: natural ? "natural" : "legal",
    nationalId: natural || p.economicCode.length === 11 ? p.economicCode : undefined,
    economicCode: p.economicCode,
    name: p.name || name,
    postalCode: p.postalCode,
  };
};

// ---------------------------------------------------------------- items

const rial = tomanToRial;

// a line priced before tax, with the tax the platform already charged
const lineItem = (p: IMoadianProfile, kind: MoadianItemKind, sstt: string, qty: number, unitToman: number, taxToman: number): IMoadianItem => {
  const am = Math.max(1, Math.round(qty) || 1);
  const fee = rial(unitToman);
  const prdis = fee * am;
  const adis = prdis;
  const vra = adis ? Math.round((rial(taxToman) / adis) * 100) : 0;
  const vam = Math.round((adis * vra) / 100);
  return { kind, sstid: p.sstid?.[kind] || "", sstt: sstt.slice(0, 400), am, mu: p.unit || "1627", fee, prdis, dis: 0, adis, vra, vam, tsstam: adis + vam };
};

// Noyan's own price, VAT inside it
const inclusiveItem = (p: IMoadianProfile, kind: MoadianItemKind, sstt: string, totalToman: number): IMoadianItem => {
  const total = rial(totalToman);
  const vra = Math.max(0, Number(p.vatPercent) || 0);
  const adis = Math.round(total / (1 + vra / 100));
  const vam = Math.round((adis * vra) / 100);
  return { kind, sstid: p.sstid?.[kind] || "", sstt: sstt.slice(0, 400), am: 1, mu: p.unit || "1627", fee: adis, prdis: adis, dis: 0, adis, vra, vam, tsstam: adis + vam };
};

const totalsOf = (items: IMoadianItem[]) => ({
  tprdis: items.reduce((s, i) => s + i.prdis, 0),
  tdis: items.reduce((s, i) => s + i.dis, 0),
  tadis: items.reduce((s, i) => s + i.adis, 0),
  tvam: items.reduce((s, i) => s + i.vam, 0),
  tbill: items.reduce((s, i) => s + i.tsstam, 0),
});

type NewInvoice = {
  source: MoadianSource;
  ref: string;
  issuedAt: Date;
  items: IMoadianItem[];
  party?: string;
  buyer?: IMoadianBuyer;
  subject?: 1 | 2 | 3 | 4;
  of?: unknown;
  refTaxId?: string;
  transaction?: unknown;
  reservation?: unknown;
  order?: unknown;
};

const create = async (p: IMoadianProfile, o: BizOwner, d: NewInvoice) => {
  const items = d.items.filter((i) => i.tsstam > 0);
  if (!items.length) return null;
  if (await MoadianInvoice.exists({ ...ownerFilter(o), ref: d.ref })) return null;
  const bumped = await MoadianProfile.findOneAndUpdate({ _id: p._id }, { $inc: { serial: 1 } }, { new: true }).lean<IMoadianProfile>();
  if (!bumped) return null;
  // the tax id may not carry a future day
  const issuedAt = d.issuedAt > new Date() ? new Date() : d.issuedAt;
  const hasBuyer = !!(d.buyer && (d.buyer.nationalId || d.buyer.economicCode));
  try {
    return await MoadianInvoice.create({
      ...ownerFields(o),
      source: d.source,
      ref: d.ref,
      transaction: d.transaction ? oid(d.transaction) : undefined,
      reservation: d.reservation ? oid(d.reservation) : undefined,
      order: d.order ? oid(d.order) : undefined,
      subject: d.subject || 1,
      type: hasBuyer ? 1 : 2,
      of: d.of ? oid(d.of) : undefined,
      refTaxId: d.refTaxId,
      serial: bumped.serial,
      taxId: makeTaxId(String(p.memoryId), issuedAt, bumped.serial),
      issuedAt,
      party: d.party?.slice(0, 200),
      buyer: hasBuyer ? d.buyer : undefined,
      items,
      total: totalsOf(items),
      status: "Queued",
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  }
};

// the same lines again, as the cancellation (3) or return (4) of `inv`
const counterOf = async (p: IMoadianProfile, inv: IMoadianInvoice, subject: 3 | 4, ref: string, issuedAt: Date) =>
  create(p, ownerOfDoc(inv), {
    source: subject === 4 ? "reversal" : inv.source,
    ref,
    issuedAt,
    items: inv.items,
    party: inv.party,
    buyer: inv.buyer,
    subject,
    of: inv._id,
    refTaxId: inv.taxId,
    reservation: inv.reservation,
    order: inv.order,
  });

// ------------------------------------------------------- from the ledger

const personName = (idn?: { givenName?: string; lastName?: string } | null) =>
  idn ? `${idn.givenName || ""} ${idn.lastName || ""}`.trim() : "";

const orderLine = async (orderId: unknown, lineId: unknown) => {
  const order = await Order.findById(orderId)
    .populate({ path: "user", select: "identity", populate: { path: "identity", select: "givenName lastName" } })
    .populate({ path: "products.item", select: "product", populate: { path: "product", select: "name" } })
    .populate({ path: "productPackages.item", select: "name" })
    .populate({ path: "services.item", select: "name" })
    .populate({ path: "servicePackages.item", select: "name" })
    .populate({ path: "tests.item", select: "test", populate: { path: "test", select: "name" } })
    .lean<Record<string, any>>();
  if (!order) return null;
  const party = personName(order.user?.identity);
  const id = idOf(lineId);
  const kinds: [string, MoadianItemKind, (l: any) => string][] = [
    ["products", "product", (l) => l.item?.product?.name || "کالا"],
    ["productPackages", "package", (l) => l.item?.name || "بسته‌ی کالا"],
    ["services", "service", (l) => l.item?.name || "خدمت"],
    ["servicePackages", "package", (l) => l.item?.name || "بسته‌ی خدمت"],
    ["tests", "test", (l) => l.item?.test?.name || "آزمایش"],
  ];
  for (const [field, kind, name] of kinds) {
    const l = (order[field] || []).find((x: any) => idOf(x._id) === id);
    if (l) return { party, kind, title: name(l), qty: Number(l.qty) || 1, unit: Number(l.price) || 0, tax: Math.max(0, Number(l.tax) || 0) };
  }
  if ((order.shipments || []).some((s: any) => idOf(s._id) === id)) return { party, kind: "shipping" as const, title: "هزینه‌ی ارسال سفارش", qty: 1, unit: 0, tax: 0 };
  return null;
};

const licenseTitle = async (t: ITransaction) => {
  for (const [field, model] of LICENSE_FIELDS) {
    const v = (t as any)[field];
    if (!v) continue;
    const plan = await model.findById(idOf(v)).select("displayName").lean<{ displayName?: string }>();
    return `اشتراک نرم‌افزار نویان${plan?.displayName ? ` - ${plan.displayName}` : ""}`;
  }
  return "";
};

const after = (d: Date | undefined, p: IMoadianProfile) => !!d && !!p.activeFrom && d >= p.activeFrom;

export const invoiceTransaction = async (t: ITransaction) => {
  const amount = Number(t.amount) || 0;
  const abs = Math.abs(amount);
  if (!abs || t.gatewayPayment || t.withdrawal) return;
  const org = orgOfTx(t);

  // the provider's sale: a visit or an order line (or its shipping)
  if (org && amount > 0 && (t.reservation || t.order) && !t.adminAction) {
    const p = await activeProfile(org);
    if (!p || !after(t.createdAt, p)) return;
    if (t.reservation) {
      const r = await Reservation.findById(t.reservation)
        .select("sessionType tax patient")
        .populate({ path: "patient", select: "givenName lastName" })
        .lean<Record<string, any>>();
      const gross = Math.max(abs, Number(t.grossAmount) || abs + (Number(t.commission) || 0));
      await create(p, org, {
        source: "visit",
        ref: `tx:${t._id}`,
        issuedAt: t.createdAt,
        items: [lineItem(p, "visit", SESSION_TITLES[r?.sessionType] || "ویزیت پزشک", 1, gross, Math.max(0, Number(r?.tax) || 0))],
        party: personName(r?.patient),
        transaction: t._id,
        reservation: t.reservation,
      });
      return;
    }
    const l = await orderLine(t.order, t.orderItem);
    if (!l) return;
    const unit = l.kind === "shipping" ? abs : l.unit;
    await create(p, org, {
      source: l.kind === "shipping" ? "shipping" : "sale",
      ref: `tx:${t._id}`,
      issuedAt: t.createdAt,
      items: [lineItem(p, l.kind, l.title, l.qty, unit, l.tax)],
      party: l.party,
      transaction: t._id,
      order: t.order,
    });
    return;
  }

  // an accepted dispute takes the visit's earning back: a return
  if (org && t.adminAction === "payoutReversal" && t.reservation) {
    const p = await activeProfile(org);
    if (!p) return;
    const original = await MoadianInvoice.findOne({ ...ownerFilter(org), reservation: oid(t.reservation), subject: 1, source: "visit", status: { $ne: "Dropped" } }).lean<IMoadianInvoice>();
    if (!original) return;
    if (original.status === "Queued" || original.status === "Rejected") {
      await MoadianInvoice.updateOne({ _id: original._id }, { $set: { status: "Dropped" } });
      return;
    }
    await counterOf(p, original, 4, `tx:${t._id}`, t.createdAt);
    return;
  }

  // a plan bought from the wallet: Noyan's sale to the provider
  if (org && amount < 0 && LICENSE_FIELDS.some(([f]) => (t as any)[f])) {
    const p = await activeProfile(PLATFORM);
    if (!p || !after(t.createdAt, p)) return;
    const { name } = await orgInfo(org).catch(() => ({ name: "" }));
    await create(p, PLATFORM, {
      source: "license",
      ref: `tx:${t._id}`,
      issuedAt: t.createdAt,
      items: [inclusiveItem(p, "subscription", (await licenseTitle(t)) || "اشتراک نرم‌افزار نویان", abs)],
      party: name,
      buyer: await buyerOfOrg(org, name),
      transaction: t._id,
    });
  }
};

// a finished campaign's net cost (what the wallet paid, less what came back)
const invoiceCampaigns = async () => {
  const p = await activeProfile(PLATFORM);
  if (!p?.activeFrom) return;
  const done = await BizCampaign.find({ status: "Sent", finishedAt: { $gte: p.activeFrom } })
    .select("ownerKind ownerId name charged refunded finishedAt")
    .lean<Record<string, any>[]>();
  if (!done.length) return;
  const have = new Set(
    (await MoadianInvoice.find({ ownerKind: "platform", ref: { $in: done.map((c) => `sms:${c._id}`) } }).select("ref").lean<{ ref: string }[]>()).map((x) => x.ref),
  );
  for (const c of done) {
    const net = (Number(c.charged) || 0) - (Number(c.refunded) || 0);
    if (net <= 0 || have.has(`sms:${c._id}`)) continue;
    const org = { kind: c.ownerKind, id: idOf(c.ownerId) } as BizOwner;
    const { name } = await orgInfo(org).catch(() => ({ name: "" }));
    await create(p, PLATFORM, {
      source: "sms",
      ref: `sms:${c._id}`,
      issuedAt: c.finishedAt,
      items: [inclusiveItem(p, "sms", `پیامک کمپین «${String(c.name).slice(0, 80)}»`, net)],
      party: name,
      buyer: await buyerOfOrg(org, name),
    });
  }
};

// last month's platform commission, once per provider, after the month ends
const invoiceCommissions = async () => {
  const p = await activeProfile(PLATFORM);
  if (!p?.activeFrom) return;
  // the Jalali month as Tehran sees it (UTC+03:30, no daylight saving)
  const last = moment().utcOffset(210).startOf("jMonth").subtract(1, "day");
  const key = `${last.jYear()}-${String(last.jMonth() + 1).padStart(2, "0")}`;
  if (p.commissionDoneFor === key) return;
  const start = last.clone().startOf("jMonth").toDate();
  const end = last.clone().endOf("jMonth").toDate();
  if (end < p.activeFrom) {
    await MoadianProfile.updateOne({ _id: p._id }, { $set: { commissionDoneFor: key } });
    return;
  }
  const from = start < p.activeFrom ? p.activeFrom : start;
  for (const [field, kind] of ORG_FIELDS) {
    const rows = await Transaction.aggregate<{ _id: unknown; sum: number }>([
      { $match: { [field]: { $exists: true, $ne: null }, commission: { $gt: 0 }, amount: { $gt: 0 }, createdAt: { $gte: from, $lte: end } } },
      { $group: { _id: `$${field}`, sum: { $sum: "$commission" } } },
    ]);
    for (const r of rows) {
      const org: BizOwner = { kind, id: idOf(r._id) };
      const { name } = await orgInfo(org).catch(() => ({ name: "" }));
      await create(p, PLATFORM, {
        source: "commission",
        ref: `commission:${kind}:${idOf(r._id)}:${key}`,
        issuedAt: end,
        items: [inclusiveItem(p, "commission", `کارمزد خدمات پلتفرم نویان - ${key.replace("-", "/")}`, r.sum)],
        party: name,
        buyer: await buyerOfOrg(org, name),
      });
    }
  }
  await MoadianProfile.updateOne({ _id: p._id }, { $set: { commissionDoneFor: key } });
};

// every transaction is looked at once; the oldest active link bounds it
const invoiceNewTransactions = async () => {
  const first = await MoadianProfile.findOne({ isActive: true, activeFrom: { $exists: true } }).sort({ activeFrom: 1 }).select("activeFrom").lean<IMoadianProfile>();
  if (!first?.activeFrom) return;
  for (;;) {
    const batch = await Transaction.find({ moadianAt: { $exists: false }, createdAt: { $gte: first.activeFrom } })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean<ITransaction[]>();
    if (!batch.length) return;
    for (const t of batch) {
      await invoiceTransaction(t).catch((err) => console.log(`[moadian] invoice for transaction ${t._id} failed:`, err));
      await Transaction.updateOne({ _id: t._id }, { $set: { moadianAt: new Date() } });
    }
    if (batch.length < 200) return;
  }
};

// ------------------------------------------------------------ the wire

const packetOf = (inv: IMoadianInvoice, p: IMoadianProfile) => {
  const b = inv.type === 1 ? inv.buyer : undefined;
  return {
    header: {
      taxid: inv.taxId,
      indatim: new Date(inv.issuedAt).getTime(),
      Indati2m: new Date(inv.issuedAt).getTime(),
      inty: inv.type,
      inno: innoOf(inv.serial),
      irtaxid: inv.refTaxId || null,
      inp: 1,
      ins: inv.subject,
      tins: p.economicCode,
      tob: b ? (b.type === "legal" ? 2 : 1) : null,
      bid: b?.nationalId || null,
      tinb: b?.economicCode || null,
      sbc: null,
      bpc: b?.postalCode || null,
      bbc: null,
      ft: null,
      bpn: null,
      scln: null,
      scc: null,
      crn: null,
      billid: null,
      tprdis: inv.total.tprdis,
      tdis: inv.total.tdis,
      tadis: inv.total.tadis,
      tvam: inv.total.tvam,
      todam: 0,
      tbill: inv.total.tbill,
      setm: 1,
      cap: inv.total.tbill,
      insp: 0,
      tvop: null,
      tax17: null,
    },
    body: inv.items.map((i) => ({
      sstid: i.sstid,
      sstt: i.sstt,
      am: i.am,
      mu: i.mu,
      fee: i.fee,
      cfee: null,
      cut: null,
      exr: null,
      prdis: i.prdis,
      dis: i.dis,
      adis: i.adis,
      vra: i.vra,
      vam: i.vam,
      odt: null,
      odr: null,
      odam: null,
      olt: null,
      olr: null,
      olam: null,
      consfee: null,
      spro: null,
      bros: null,
      tcpbs: null,
      cop: null,
      vop: null,
      bsrn: null,
      tsstam: i.tsstam,
    })),
    payments: [],
    extension: null,
  };
};

// what can be told before anything is sent
const localProblems = (inv: IMoadianInvoice) => {
  const out: { code: string; message: string }[] = [];
  for (const i of inv.items)
    if (!/^\d{13}$/.test(i.sstid || ""))
      // the panel names the line kind in its own language (code sstid:<kind>)
      out.push({ code: `sstid:${i.kind}`, message: "شناسه‌ی کالا یا خدمت در تنظیمات مودیان نیست" });
  if (inv.type === 1 && !inv.buyer?.nationalId && !inv.buyer?.economicCode) out.push({ code: "buyer", message: "مشخصات خریدار کامل نیست" });
  return out;
};

const backoff = (attempts: number) => new Date(Date.now() + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000);

const sendDue = async () => {
  const due = await MoadianInvoice.find({ status: "Queued", $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] })
    .sort({ issuedAt: 1, serial: 1 })
    .limit(200)
    .lean<IMoadianInvoice[]>();
  const groups = new Map<string, IMoadianInvoice[]>();
  for (const inv of due) {
    const k = `${inv.ownerKind}:${idOf(inv.ownerId)}`;
    groups.set(k, [...(groups.get(k) || []), inv]);
  }
  for (const list of groups.values()) {
    const owner = ownerOfDoc(list[0]);
    const p = await activeProfile(owner);
    if (!p) continue;
    const ready: IMoadianInvoice[] = [];
    for (const inv of list) {
      // a cancellation or return waits for its original's answer
      if (inv.of) {
        const orig = await MoadianInvoice.findById(inv.of).select("status").lean<IMoadianInvoice>();
        if (orig?.status === "Sent" || orig?.status === "Queued") continue;
      }
      const problems = localProblems(inv);
      if (problems.length) {
        await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { status: "Rejected", taxErrors: problems, decidedAt: new Date() } });
        continue;
      }
      ready.push(inv);
    }
    for (let i = 0; i < ready.length; i += 20) {
      const chunk = ready.slice(i, i + 20).map((inv) => ({ inv, uid: crypto.randomUUID() }));
      try {
        const sent = await sendInvoices(credsOf(p), chunk.map((c) => ({ uid: c.uid, json: packetOf(c.inv, p) })));
        const byUid = new Map(sent.map((s) => [s.uid, s.referenceNumber]));
        for (const c of chunk) {
          const ref = byUid.get(c.uid);
          await MoadianInvoice.updateOne(
            { _id: c.inv._id },
            ref
              ? { $set: { status: "Sent", uid: c.uid, referenceNumber: ref, sentAt: new Date(), taxErrors: [] }, $inc: { attempts: 1 } }
              : { $set: { nextAttemptAt: backoff(c.inv.attempts + 1) }, $inc: { attempts: 1 } },
          );
        }
        await MoadianProfile.updateOne({ _id: p._id }, { $set: { lastSentAt: new Date() }, $unset: { lastError: 1, lastErrorAt: 1 } });
      } catch (err) {
        const message = String((err as Error)?.message || err).slice(0, 300);
        for (const c of chunk)
          await MoadianInvoice.updateOne({ _id: c.inv._id }, { $set: { nextAttemptAt: backoff(c.inv.attempts + 1), taxErrors: [{ code: "net", message }] }, $inc: { attempts: 1 } });
        await MoadianProfile.updateOne({ _id: p._id }, { $set: { lastError: message, lastErrorAt: new Date() } });
      }
    }
  }
};

const inquireDue = async () => {
  const waiting = await MoadianInvoice.find({ status: "Sent", sentAt: { $lte: new Date(Date.now() - 15_000) } })
    .sort({ sentAt: 1 })
    .limit(200)
    .lean<IMoadianInvoice[]>();
  const groups = new Map<string, IMoadianInvoice[]>();
  for (const inv of waiting) {
    const k = `${inv.ownerKind}:${idOf(inv.ownerId)}`;
    groups.set(k, [...(groups.get(k) || []), inv]);
  }
  for (const list of groups.values()) {
    const p = await activeProfile(ownerOfDoc(list[0]));
    if (!p) continue;
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      let answers;
      try {
        answers = await inquire(credsOf(p), chunk.map((c) => String(c.referenceNumber)));
      } catch {
        continue;
      }
      for (const a of answers) {
        const inv = chunk.find((c) => c.referenceNumber === a.referenceNumber);
        if (!inv) continue;
        if (a.status === "SUCCESS")
          await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { status: "Accepted", decidedAt: new Date(), taxErrors: [], taxWarnings: a.warnings } });
        else if (a.status === "FAILED")
          await MoadianInvoice.updateOne(
            { _id: inv._id },
            { $set: { status: "Rejected", decidedAt: new Date(), taxErrors: a.errors.length ? a.errors : [{ message: "سامانه‌ی مودیان صورتحساب را نپذیرفت" }], taxWarnings: a.warnings } },
          );
      }
    }
  }
};

// --------------------------------------------------------------- actions

const own = async (o: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("صورتحساب پیدا نشد", 404);
  const inv = await MoadianInvoice.findOne({ _id: id, ...ownerFilter(o) }).lean<IMoadianInvoice>();
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  return inv;
};

const mustBeActive = async (o: BizOwner) => {
  const p = await activeProfile(o);
  if (!p) throw new AppError("اتصال به سامانه‌ی مودیان فعال نیست", 400);
  return p;
};

// sstids are read again from the settings: that is usually what was fixed
const requeue = async (o: BizOwner, inv: IMoadianInvoice) => {
  const p = await mustBeActive(o);
  const items = inv.items.map((i) => ({ ...i, sstid: p.sstid?.[i.kind as MoadianItemKind] || i.sstid }));
  await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { status: "Queued", items, taxErrors: [], attempts: 0 }, $unset: { nextAttemptAt: 1, decidedAt: 1 } });
};

export const retryInvoice = async (o: BizOwner, id: string) => {
  const inv = await own(o, id);
  if (inv.status !== "Rejected" && !(inv.status === "Queued" && inv.attempts > 0)) throw new AppError("این صورتحساب منتظر ارسال یا پاسخ است", 400);
  await requeue(o, inv);
};

export const retryAllRejected = async (o: BizOwner) => {
  await mustBeActive(o);
  const list = await MoadianInvoice.find({ ...ownerFilter(o), status: "Rejected" }).lean<IMoadianInvoice[]>();
  for (const inv of list) await requeue(o, inv);
  return list.length;
};

// the buyer asked for an invoice in their name: a type-2 invoice not yet
// registered just gets the buyer; a registered one is cancelled and issued
// again as type 1
export const setBuyer = async (o: BizOwner, id: string, buyer: IMoadianBuyer) => {
  const inv = await own(o, id);
  if (inv.subject !== 1) throw new AppError("فقط صورتحساب اصلی خریدار می‌گیرد", 400);
  if (inv.replacedBy || inv.status === "Dropped") throw new AppError("این صورتحساب جایگزین شده است", 400);
  if (inv.status === "Sent") throw new AppError("پاسخ سامانه‌ی مودیان هنوز نیامده است؛ کمی بعد دوباره امتحان کنید", 400);
  const p = await mustBeActive(o);
  if (inv.status === "Queued" || inv.status === "Rejected") {
    await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { buyer, type: 1, status: "Queued", taxErrors: [], attempts: 0 }, $unset: { nextAttemptAt: 1 } });
    return;
  }
  const n = await MoadianInvoice.countDocuments({ ...ownerFilter(o), ref: new RegExp(`^${inv.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`) });
  await counterOf(p, inv, 3, `${inv.ref}:cancel${n}`, new Date());
  const fresh = await create(p, o, {
    source: inv.source,
    ref: `${inv.ref}:buyer${n}`,
    issuedAt: new Date(),
    items: inv.items,
    party: buyer.name || inv.party,
    buyer,
    transaction: inv.transaction,
    reservation: inv.reservation,
    order: inv.order,
  });
  if (fresh) await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { replacedBy: fresh._id } });
};

// a registered invoice made by mistake is cancelled; one not yet registered
// is simply never sent
export const cancelInvoice = async (o: BizOwner, id: string) => {
  const inv = await own(o, id);
  if (inv.subject !== 1 || inv.replacedBy || inv.status === "Dropped") throw new AppError("این صورتحساب ابطال‌شدنی نیست", 400);
  if (inv.status === "Sent") throw new AppError("پاسخ سامانه‌ی مودیان هنوز نیامده است؛ کمی بعد دوباره امتحان کنید", 400);
  if (inv.status === "Queued" || inv.status === "Rejected") {
    await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { status: "Dropped" } });
    return;
  }
  const p = await mustBeActive(o);
  const c = await counterOf(p, inv, 3, `${inv.ref}:cancel`, new Date());
  if (c) await MoadianInvoice.updateOne({ _id: inv._id }, { $set: { replacedBy: c._id } });
};

export const invoicePacket = async (o: BizOwner, id: string) => {
  const inv = await own(o, id);
  const p = await MoadianProfile.findOne(ownerFilter(o)).lean<IMoadianProfile>();
  return p ? packetOf(inv, p) : null;
};

// ------------------------------------------------------------------ job

let running = false;
export const runMoadianSweep = async () => {
  if (running) return;
  running = true;
  try {
    await invoiceNewTransactions();
    await invoiceCampaigns();
    await invoiceCommissions();
    await sendDue();
    await inquireDue();
  } catch (err) {
    console.log("[moadian] sweep failed:", err);
  } finally {
    running = false;
  }
};

export const startMoadianJob = (intervalMs = 60_000) => {
  setTimeout(() => void runMoadianSweep(), 20_000);
  setInterval(() => void runMoadianSweep(), intervalMs);
};
