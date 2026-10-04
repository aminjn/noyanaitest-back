import { notifyWithSms } from "../../Services/notificationSmsService";
import mongoose from "mongoose";
import BizCampaign, { IBizAudience, IBizCampaign } from "../../Models/BizCampaign";
import BizContact from "../../Models/BizContact";
import SmsOptOut from "../../Models/SmsOptOut";
import Wallet from "../../Models/Wallet";
import Transaction from "../../Models/Transaction";
import Notification from "../../Models/Notification";
import GlobalFinanceSettings from "../../Models/GlobalFinanceSettings";
import SmsGatewaySettings from "../../Models/SmsGatewaySettings";
import DoctorProfile from "../../Models/DoctorProfile";
import Pharmacy from "../../Models/Pharmacy";
import Clinic from "../../Models/Clinic";
import Hospital from "../../Models/Hospital";
import ParaClinic from "../../Models/Paraclinic";
import Insurance from "../../Models/Insurance";
import DoctorProfileLicense from "../../Models/DoctorProfileLicense";
import PharmacyProfileLicense from "../../Models/PharmacyProfileLicense";
import ClinicProfileLicense from "../../Models/ClinicProfileLicense";
import HospitalProfileLicense from "../../Models/HospitalProfileLicense";
import ParaClinicProfileLicense from "../../Models/ParaClinicProfileLicense";
import InsuranceProfileLicense from "../../Models/InsuranceProfileLicense";
import BaseDoctorLicense from "../../Models/BaseDoctorLicense";
import BasePharmacyLicense from "../../Models/BasePharmacyLicense";
import BaseClinicLicense from "../../Models/BaseClinicLicense";
import BaseHospitalLicense from "../../Models/BaseHospitalLicense";
import BaseParaClinicLicense from "../../Models/BaseParaClinicLicense";
import BaseInsuranceLicense from "../../Models/BaseInsuranceLicense";
import { BizOwnerKind } from "../../Models/BizAccount";
import AppError from "../AppError";
import * as env from "../Env";
import { getAppConfig } from "../appConfig";
import { getSmsGateway } from "../sendSms";
import { siteDefaultLocale } from "../locales";
import { translateNotificationText } from "../i18n/translateNotification";
import { notifyUserAlertSubscribers } from "../../Services/userAlertService";
import { BizOwner } from "./coa";
import { audienceContacts, own } from "./crm";
import { jalaliToday } from "./payroll";

// Noyan Business SMS campaigns (2026-10, docs/business-suite.md phase 4),
// after nexxacrm's marketing.ts and sms.ts, with the rules an Iranian
// advertising SMS lives under: it goes only to the owner's own patients and
// customers (who booked or bought - the prior relationship the regulator's
// consent rule asks for), never to one who opted out of this owner or of
// all of Noyan, every message carries an opt-out link, it leaves from the
// platform's advertising line, between 08:00 and 21:00 Tehran time, and only
// after the super admin approved its text (medical advertising rules). It is
// paid from the plan's monthly quota first, then from the Noyan wallet;
// what could not be sent is given back.

type OrgCfg = {
  org: mongoose.Model<any>;
  profile: mongoose.Model<any>;
  base: mongoose.Model<any>;
  // the Transaction field naming the org (Lib/business/ledgerPoster.ts)
  field: string;
};

const ORGS: Record<Exclude<BizOwnerKind, "platform">, OrgCfg> = {
  doctor: { org: DoctorProfile, profile: DoctorProfileLicense, base: BaseDoctorLicense, field: "doctor" },
  pharmacy: { org: Pharmacy, profile: PharmacyProfileLicense, base: BasePharmacyLicense, field: "pharmacy" },
  clinic: { org: Clinic, profile: ClinicProfileLicense, base: BaseClinicLicense, field: "clinic" },
  hospital: { org: Hospital, profile: HospitalProfileLicense, base: BaseHospitalLicense, field: "hospital" },
  paraClinic: { org: ParaClinic, profile: ParaClinicProfileLicense, base: BaseParaClinicLicense, field: "paraClinic" },
  insurance: { org: Insurance, profile: InsuranceProfileLicense, base: BaseInsuranceLicense, field: "insurance" },
};

const cfgOf = (owner: BizOwner) => {
  const c = ORGS[owner.kind as keyof typeof ORGS];
  if (!c || !owner.id) throw new AppError("این بخش برای این حساب نیست", 400);
  return c;
};

// who holds the wallet, and the name a recipient knows the sender by
export const orgInfo = async (owner: BizOwner) => {
  const o = await cfgOf(owner)
    .org.findById(owner.id)
    .select("user name firstName lastName")
    .lean<{ user?: unknown; name?: string; firstName?: string; lastName?: string }>();
  if (!o) throw new AppError("این بخش برای این حساب نیست", 400);
  const name = owner.kind === "doctor" ? `${o.firstName || ""} ${o.lastName || ""}`.trim() : o.name || "";
  return { user: o.user, name };
};

// ---------------------------------------------------------------- text

// GSM-7 or not: a Persian text is UCS-2 (70 a part, 67 when split), a Latin
// one 160 (153 when split)
const GSM = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export const smsParts = (text: string) => {
  const ucs = !GSM.test(text);
  const len = [...text].length;
  const [one, many] = ucs ? [70, 67] : [160, 153];
  return len <= one ? 1 : Math.ceil(len / many);
};

const OPTOUT_WORD = "لغو پیامک";
const siteBase = async () => {
  const cfg = await getAppConfig();
  return (cfg.siteBaseUrl || "").replace(/\/+$/, "");
};
// the text a recipient gets: the owner's text, then the opt-out link
export const messageFor = (text: string, base: string, code: string) =>
  `${text.trim()}\n${translateNotificationText(OPTOUT_WORD, siteDefaultLocale())}: ${base}/o/${code}`;

// the parts every message takes (the code is the same length for all)
export const campaignParts = async (text: string) => smsParts(messageFor(text, await siteBase(), "XXXXXXXX"));

// ---------------------------------------------------------------- money

const unitPrice = async () => {
  const s = await GlobalFinanceSettings.findOne().select("campaignSmsPrice").lean<{ campaignSmsPrice?: number }>();
  return Math.max(0, Math.round(s?.campaignSmsPrice ?? 150));
};

// the plan's monthly SMS: the current plan, else the default plan
export const monthlyQuota = async (owner: BizOwner) => {
  const c = cfgOf(owner);
  const lic = await c.profile
    .findOne({ owner: owner.id })
    .populate("baseLicense", "monthlySmsQuota")
    .lean<{ expiresAt?: Date; baseLicense?: { monthlySmsQuota?: number } }>();
  if (lic && !(lic.expiresAt && lic.expiresAt < new Date()) && lic.baseLicense)
    return Math.max(0, lic.baseLicense.monthlySmsQuota || 0);
  const def = await c.base.findOne({ isDefault: true }).select("monthlySmsQuota").lean<{ monthlySmsQuota?: number }>();
  return Math.max(0, def?.monthlySmsQuota || 0);
};

const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const BizCounter =
  (mongoose.models.BizCounter as mongoose.Model<{ _id: string; seq: number }>) ||
  mongoose.model<{ _id: string; seq: number }>("BizCounter", CounterSchema);

const quotaKey = (owner: BizOwner) => {
  const { year, month } = jalaliToday();
  return `smsquota:${owner.kind}:${owner.id}:${year}-${month}`;
};

export const quotaUsed = async (owner: BizOwner) =>
  (await BizCounter.findById(quotaKey(owner)).lean())?.seq || 0;

// take up to `want` parts of this month's quota, atomically
const takeQuota = async (owner: BizOwner, want: number, quota: number) => {
  const key = quotaKey(owner);
  for (let i = 0; i < 5; i++) {
    const used = (await BizCounter.findById(key).lean())?.seq || 0;
    const take = Math.max(0, Math.min(want, quota - used));
    if (!take) return 0;
    const res = await BizCounter.updateOne(
      { _id: key, seq: used },
      { $inc: { seq: take } },
      { upsert: used === 0 },
    ).catch(() => ({ modifiedCount: 0, upsertedCount: 0 }));
    if (res.modifiedCount || ("upsertedCount" in res && res.upsertedCount)) return take;
  }
  return 0;
};

const giveQuota = (owner: BizOwner, n: number) =>
  n > 0 ? BizCounter.updateOne({ _id: quotaKey(owner) }, { $inc: { seq: -n } }) : Promise.resolve();

export type Estimate = {
  recipients: number;
  parts: number;
  totalParts: number;
  quota: number;
  quotaLeft: number;
  fromQuota: number;
  fromWallet: number;
  unitPrice: number;
  cost: number;
  balance: number;
  affordable: boolean;
};

export const estimate = async (owner: BizOwner, text: string, audience: Partial<IBizAudience>): Promise<Estimate> => {
  const [contacts, parts, quota, used, price, info] = await Promise.all([
    audienceContacts(owner, audience),
    campaignParts(text || " "),
    monthlyQuota(owner),
    quotaUsed(owner),
    unitPrice(),
    orgInfo(owner),
  ]);
  const totalParts = contacts.length * parts;
  const quotaLeft = Math.max(0, quota - used);
  const fromQuota = Math.min(totalParts, quotaLeft);
  const fromWallet = totalParts - fromQuota;
  const wallet = await Wallet.findOne({ user: info.user }).select("balance").lean<{ balance?: number }>();
  const balance = wallet?.balance || 0;
  const cost = fromWallet * price;
  return {
    recipients: contacts.length,
    parts,
    totalParts,
    quota,
    quotaLeft,
    fromQuota,
    fromWallet,
    unitPrice: price,
    cost,
    balance,
    affordable: cost <= balance,
  };
};

// ---------------------------------------------------------------- flow

const EDITABLE = ["Draft", "Rejected"];

export const submitCampaign = async (owner: BizOwner, id: unknown) => {
  const c = await BizCampaign.findOne({ ...own(owner), _id: id }).lean<IBizCampaign>();
  if (!c) throw new AppError("کمپین پیدا نشد", 404);
  if (!EDITABLE.includes(c.status)) throw new AppError("این کمپین قبلاً فرستاده شده است", 400);
  const e = await estimate(owner, c.text, c.audience);
  if (!e.recipients) throw new AppError("هیچ مخاطبی با این فیلتر پیدا نشد", 400);
  if (!e.affordable) throw new AppError("موجودی کیف پول برای این کمپین کافی نیست؛ کیف پول را شارژ کنید", 400);
  const res = await BizCampaign.updateOne(
    { _id: c._id, status: { $in: EDITABLE } },
    {
      $set: { status: "Pending", submittedAt: new Date(), recipients: e.recipients, parts: e.parts, unitPrice: e.unitPrice },
      $unset: { rejectReason: 1, decidedAt: 1, decidedBy: 1 },
    },
  );
  if (!res.modifiedCount) throw new AppError("این کمپین قبلاً فرستاده شده است", 400);
  const info = await orgInfo(owner);
  notifyUserAlertSubscribers(
    "newSmsCampaign",
    { title: "کمپین پیامکی برای تأیید", message: `«${c.name}» از ${info.name} برای ${e.recipients} مخاطب` },
    { requestId: String(c._id), name: info.name },
  ).catch((err) => console.log("[campaign] alert failed:", err));
  return BizCampaign.findById(c._id).lean();
};

export const cancelCampaign = async (owner: BizOwner, id: unknown) => {
  const res = await BizCampaign.updateOne(
    { ...own(owner), _id: id, status: { $in: ["Draft", "Pending", "Rejected", "Approved"] } },
    { $set: { status: "Cancelled" } },
  );
  if (!res.modifiedCount) throw new AppError("کمپینی که در حال ارسال یا ارسال‌شده است لغو نمی‌شود", 400);
  return BizCampaign.findById(id).lean();
};

// Tehran wall-clock: campaigns go out 08:00-21:00
const TZ = "Asia/Tehran";
const tehranHour = (d: Date) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d)) % 24;
export const SEND_FROM = 8;
export const SEND_UNTIL = 21;
export const inWindow = (d = new Date()) => {
  const h = tehranHour(d);
  return h >= SEND_FROM && h < SEND_UNTIL;
};
// the next moment the window is open (checked hour by hour)
const nextWindow = (from = new Date()) => {
  if (inWindow(from)) return from;
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 26; i++) {
    d.setTime(d.getTime() + 3600_000);
    if (inWindow(d)) return d;
  }
  return from;
};

// the super admin approves (the queue's other actions - reject with a
// reason, reopen - are the generic ones of Controllers/adminRequestsController.ts)
export const approveCampaign = async (id: unknown, adminId?: unknown) => {
  const gateway = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean();
  if (!gateway?.marketingFromNumber && env.NODE_ENV !== "development")
    throw new AppError("شماره‌ی خط تبلیغاتی در تنظیمات پیامک ثبت نشده است", 400);
  if (!(await siteBase())) throw new AppError("نشانی سایت در تنظیمات کلی ثبت نشده است؛ لینک لغو پیامک بدون آن ساخته نمی‌شود", 400);
  const sendAfter = nextWindow();
  const c = await BizCampaign.findOneAndUpdate(
    { _id: id, status: "Pending" },
    { $set: { status: "Approved", decidedAt: new Date(), decidedBy: adminId, sendAfter } },
    { new: true },
  ).lean<IBizCampaign>();
  if (!c) throw new AppError("فقط درخواست در انتظار بررسی را می‌توان تأیید کرد", 400);
  const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
  const info = await orgInfo(owner).catch(() => null);
  if (info?.user) {
    await Notification.create({
      user: info.user,
      source: "System",
      title: "کمپین پیامکی تأیید شد",
      message: `کمپین «${c.name}» تأیید شد و در ساعت مجاز ارسال (۸ تا ۲۱) فرستاده می‌شود.`,
    }).catch(() => {});
    notifyWithSms("smsCampaignApprovedProvider", info.user as any, { name: c.name || "" });
  }
  setImmediate(() => runCampaignSweep().catch((err) => console.log("[campaign] sweep failed:", err)));
  return c;
};

// ---------------------------------------------------------------- sending

// One free-text SMS from the advertising line (IPPanel "webservice" send).
// With no gateway token (development) it is printed, not sent.
const sendOne = async (to: string, message: string, from: string) => {
  const gateway = await getSmsGateway();
  if (env.NODE_ENV === "development" || !gateway.token) {
    console.log(`[SMS campaign] from=${from || "-"} to=${to}: ${message}`);
    return true;
  }
  try {
    const res = await fetch(gateway.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: gateway.token },
      body: JSON.stringify({ sending_type: "webservice", from_number: from, message, params: { recipients: [to] } }),
    });
    const body = (await res.json().catch(() => null)) as { meta?: { status?: boolean } } | null;
    return res.ok && !!body?.meta?.status;
  } catch (err) {
    console.log(`[SMS campaign] to=${to} failed:`, err);
    return false;
  }
};

const walletTx = async (owner: BizOwner, campaignId: unknown, user: unknown, amount: number) => {
  const field = cfgOf(owner).field;
  return Transaction.create({ user, amount, [field]: owner.id, smsCampaign: campaignId });
};

// Charge, send, give back what was not sent. Claimed atomically, so two
// sweeps never send one campaign twice.
const runOne = async (c: IBizCampaign) => {
  const claimed = await BizCampaign.findOneAndUpdate(
    { _id: c._id, status: "Approved" },
    { $set: { status: "Sending", startedAt: new Date() } },
    { new: true },
  ).lean<IBizCampaign>();
  if (!claimed) return;
  const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
  const fail = async (reason: string, quotaBack = 0) => {
    await giveQuota(owner, quotaBack);
    await BizCampaign.updateOne({ _id: c._id }, { $set: { status: "Rejected", rejectReason: reason, decidedAt: new Date() } });
    const info = await orgInfo(owner).catch(() => null);
    if (info?.user) {
      await Notification.create({
        user: info.user,
        source: "System",
        title: "کمپین پیامکی ارسال نشد",
        message: `کمپین «${c.name}» ارسال نشد. دلیل: ${reason}`,
      }).catch(() => {});
      notifyWithSms("smsCampaignFailedProvider", info.user as any, { name: c.name || "", reason });
    }
  };
  const [info, contacts, base, gateway] = await Promise.all([
    orgInfo(owner),
    audienceContacts(owner, c.audience),
    siteBase(),
    SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean(),
  ]);
  if (!contacts.length) return fail("هیچ مخاطبی با این فیلتر پیدا نشد");
  const parts = smsParts(messageFor(c.text, base, "XXXXXXXX"));
  const total = contacts.length * parts;
  const price = c.unitPrice || (await unitPrice());
  const fromQuota = await takeQuota(owner, total, await monthlyQuota(owner));
  const fromWallet = total - fromQuota;
  const cost = fromWallet * price;
  let txId: unknown;
  if (cost > 0) {
    await Wallet.updateOne({ user: info.user }, { $setOnInsert: { user: info.user } }, { upsert: true });
    const debited = await Wallet.findOneAndUpdate({ user: info.user, balance: { $gte: cost } }, { $inc: { balance: -cost } });
    if (!debited) return fail("موجودی کیف پول برای این کمپین کافی نیست؛ کیف پول را شارژ کنید", fromQuota);
    txId = (await walletTx(owner, c._id, info.user, -cost))._id;
  }
  await BizCampaign.updateOne(
    { _id: c._id },
    { $set: { recipients: contacts.length, parts, fromQuota, fromWallet, unitPrice: price, charged: cost, transaction: txId } },
  );
  const from = gateway?.marketingFromNumber || "";
  let sent = 0;
  let failed = 0;
  // a few at a time: the gateway takes one recipient per free-text request
  const queue = [...contacts];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (await sendOne(next.phone, messageFor(c.text, base, next.optCode), from)) sent++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // what was not sent: the wallet's share back first, then the quota's
  const unsentParts = failed * parts;
  const walletBack = Math.min(unsentParts, fromWallet);
  const refund = walletBack * price;
  if (refund > 0) {
    await Wallet.updateOne({ user: info.user }, { $inc: { balance: refund } });
    await walletTx(owner, c._id, info.user, refund);
  }
  await giveQuota(owner, unsentParts - walletBack);
  await BizCampaign.updateOne(
    { _id: c._id },
    { $set: { status: "Sent", finishedAt: new Date(), sentCount: sent, failedCount: failed, refunded: refund } },
  );
};

let running = false;
export const runCampaignSweep = async () => {
  if (running || !inWindow()) return;
  running = true;
  try {
    const due = await BizCampaign.find({ status: "Approved", sendAfter: { $lte: new Date() } })
      .sort({ sendAfter: 1 })
      .limit(5)
      .lean<IBizCampaign[]>();
    for (const c of due) await runOne(c).catch((err) => console.log(`[campaign] ${c._id} failed:`, err));
  } finally {
    running = false;
  }
};

export const startCampaignJob = () => {
  setInterval(() => runCampaignSweep().catch((err) => console.log("[campaign] sweep failed:", err)), 60_000);
  // a campaign left half-sent by a restart is finished as sent with what
  // its counters say; nothing is sent twice
  BizCampaign.updateMany(
    { status: "Sending", startedAt: { $lt: new Date(Date.now() - 30 * 60_000) } },
    { $set: { status: "Sent", finishedAt: new Date() } },
  ).catch(() => {});
};

// ---------------------------------------------------------------- opt-out

export const optOutInfo = async (code: string) => {
  const contact = await BizContact.findOne({ optCode: code }).select("ownerKind ownerId smsOptOut phone").lean();
  if (!contact) return null;
  const info = await orgInfo({ kind: contact.ownerKind, id: String(contact.ownerId) }).catch(() => null);
  const all = !!(await SmsOptOut.exists({ phone: contact.phone }));
  return { name: info?.name || "", optedOut: contact.smsOptOut, all };
};

export const optOut = async (code: string, scope: "owner" | "all") => {
  const contact = await BizContact.findOneAndUpdate(
    { optCode: code },
    { $set: { smsOptOut: true, optOutAt: new Date() } },
    { new: true },
  ).lean();
  if (!contact) throw new AppError("این لینک معتبر نیست", 404);
  if (scope === "all") await SmsOptOut.updateOne({ phone: contact.phone }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  return optOutInfo(code);
};
