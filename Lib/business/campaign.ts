import { notifyWithSms } from "../../Services/notificationSmsService";
import mongoose from "mongoose";
import BizCampaign, { IBizAudience, IBizCampaign } from "../../Models/BizCampaign";
import BizContact from "../../Models/BizContact";
import SmsOptOut from "../../Models/SmsOptOut";
import { creditScope, debitSpending, scopeOfOwner, scopeTxFields, spendableBalance, WalletScope } from "../walletScope";
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
import { isLicenseExpired } from "../licenseActive";
import { minimalModules } from "../licenseTiers";
import * as env from "../Env";
import { getAppConfig } from "../appConfig";
import { notifyUserAlertSubscribers } from "../../Services/userAlertService";
import { BizOwner } from "./coa";
import BizMessage from "../../Models/BizMessage";
import BizTemplate, { IBizTemplate } from "../../Models/BizTemplate";
import { audienceContacts, own } from "./crm";
import {
  messageFor,
  newTrackedLink,
  orgPublicUrl,
  randomCode,
  renderText,
  sendOne,
  siteBase,
  smsDate,
  smsParts,
  SmsVars,
  trackedUrl,
} from "./crmSend";

export { messageFor, smsParts };
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

// the variables of one recipient; the link codes are a fixed length, so a
// placeholder counts the same parts as the real one
export const varsFor = (
  c: { name?: string; lastVisitAt?: Date },
  orgName: string,
  link: string,
  review?: string,
): SmsVars => ({
  name: c.name || "",
  firstName: (c.name || "").split(/\s+/)[0] || "",
  org: orgName,
  link,
  review: review || link,
  lastVisit: smsDate(c.lastVisitAt),
});
const PLACEHOLDER_LINK = (base: string) => trackedUrl(base, "cXXXXX", "XXXXXX");

// the parts one message of this text takes (with a typical name)
export const campaignParts = async (text: string) => {
  const base = await siteBase();
  return smsParts(messageFor(renderText(text, varsFor({ name: "XXXXXX XXXXXXXX" }, "XXXXXXXXXX", PLACEHOLDER_LINK(base))), base, "XXXXXXXX"));
};

// the text a recipient sees in the preview: filled with a sample patient
export const previewText = async (owner: BizOwner, text: string, sample?: { name?: string; lastVisitAt?: Date }) => {
  const [base, info, someone] = await Promise.all([
    siteBase(),
    orgInfo(owner).catch(() => ({ name: "" })),
    // a real patient of this owner shows how a name fills in
    sample?.name
      ? Promise.resolve(sample)
      : BizContact.findOne({ ...own(owner), name: { $ne: "" } }).sort({ lastSeenAt: -1 }).select("name lastVisitAt").lean<{ name?: string; lastVisitAt?: Date }>(),
  ]);
  sample = someone || sample;
  return messageFor(renderText(text, varsFor(sample || {}, info.name, PLACEHOLDER_LINK(base))), base, "a1B2c3D4");
};

// the plan modules this owner has now (its own plan, else the default one,
// else the free tier) - the job-side twin of each panel's requireLicenseModule
export const ownerModules = async (owner: BizOwner): Promise<string[]> => {
  const c = cfgOf(owner);
  const lic = await c.profile.findOne({ owner: owner.id }).select("modules expiresAt").lean<{ modules?: string[]; expiresAt?: Date }>();
  if (lic && !isLicenseExpired(lic)) return lic.modules || [];
  const def = await c.base.findOne({ isDefault: true }).select("modules").lean<{ modules?: string[] }>();
  if (def) return def.modules || [];
  return minimalModules[owner.kind as keyof typeof minimalModules] || [];
};

// ---------------------------------------------------------------- money

export const unitPrice = async () => {
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
export const takeQuota = async (owner: BizOwner, want: number, quota: number) => {
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

export const giveQuota = (owner: BizOwner, n: number) =>
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
  const [contacts, parts, quota, used, price, info, base] = await Promise.all([
    audienceContacts(owner, audience),
    campaignParts(text || " "),
    monthlyQuota(owner),
    quotaUsed(owner),
    unitPrice(),
    orgInfo(owner),
    siteBase(),
  ]);
  // each recipient's own text (names differ in length); a very large list
  // is counted at the typical length
  const totalParts =
    contacts.length <= 5000
      ? contacts.reduce(
          (n, c) => n + smsParts(messageFor(renderText(text || " ", varsFor(c, info.name, PLACEHOLDER_LINK(base))), base, "XXXXXXXX")),
          0,
        )
      : contacts.length * parts;
  const quotaLeft = Math.max(0, quota - used);
  const fromQuota = Math.min(totalParts, quotaLeft);
  const fromWallet = totalParts - fromQuota;
  const balance = await smsBalance(owner, info.user);
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
// the next moment the window [from, until) is open (checked hour by hour)
export const nextWindow = (from = new Date(), wFrom = SEND_FROM, wUntil = SEND_UNTIL) => {
  const a = Math.max(SEND_FROM, wFrom);
  const b = Math.min(SEND_UNTIL, wUntil);
  const open = (d: Date) => {
    const h = tehranHour(d);
    return h >= a && h < b;
  };
  if (open(from)) return from;
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 26; i++) {
    d.setTime(d.getTime() + 3600_000);
    if (open(d)) return d;
  }
  return from;
};
export const inOwnWindow = (wFrom = SEND_FROM, wUntil = SEND_UNTIL, d = new Date()) => {
  const h = tehranHour(d);
  return h >= Math.max(SEND_FROM, wFrom) && h < Math.min(SEND_UNTIL, wUntil);
};

// the super admin approves (the queue's other actions - reject with a
// reason, reopen - are the generic ones of Controllers/adminRequestsController.ts)
export const approveCampaign = async (id: unknown, adminId?: unknown) => {
  const gateway = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean();
  if (!gateway?.marketingFromNumber && env.NODE_ENV !== "development")
    throw new AppError("شماره‌ی خط تبلیغاتی در تنظیمات پیامک ثبت نشده است", 400);
  if (!(await siteBase())) throw new AppError("نشانی سایت در تنظیمات کلی ثبت نشده است؛ لینک لغو پیامک بدون آن ساخته نمی‌شود", 400);
  const pending = await BizCampaign.findOne({ _id: id, status: "Pending" }).select("sendAt windowFrom windowUntil").lean<IBizCampaign>();
  if (!pending) throw new AppError("فقط درخواست در انتظار بررسی را می‌توان تأیید کرد", 400);
  const at = pending.sendAt && pending.sendAt > new Date() ? pending.sendAt : new Date();
  const sendAfter = nextWindow(at, pending.windowFrom, pending.windowUntil);
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

// The super admin clears a CRM SMS template (Models/BizTemplate.ts): from
// then on its automations may run and it may be sent one-off. Reject and
// reopen are the queue's generic actions.
export const approveTemplateText = async (id: unknown, adminId?: unknown) => {
  const t = await BizTemplate.findOneAndUpdate(
    { _id: id, status: "Pending" },
    { $set: { status: "Approved", decidedAt: new Date(), decidedBy: adminId }, $unset: { rejectReason: 1 } },
    { new: true },
  ).lean<IBizTemplate>();
  if (!t) throw new AppError("فقط درخواست در انتظار بررسی را می‌توان تأیید کرد", 400);
  const info = await orgInfo({ kind: t.ownerKind, id: String(t.ownerId) } as BizOwner).catch(() => null);
  if (info?.user)
    await Notification.create({
      user: info.user,
      source: "System",
      title: "قالب پیامک تأیید شد",
      message: `قالب «${t.name}» تأیید شد و خودکارسازی‌های آن می‌توانند فعال شوند.`,
    }).catch(() => {});
  return t;
};

// ---------------------------------------------------------------- sending

// `payer`: the wallet that paid or is paid back (Lib/walletScope.ts) - a
// clinic's / hospital's own wallet, or the owner's personal one
export const walletTx = async (
  owner: BizOwner,
  campaignId: unknown,
  user: unknown,
  amount: number,
  ref: "smsCampaign" | "smsAutomation" | "smsMessage" = "smsCampaign",
  payer?: WalletScope | null,
) => {
  const field = cfgOf(owner).field;
  return Transaction.create({ user, amount, [field]: owner.id, [ref]: campaignId, ...(payer ? await scopeTxFields(payer) : {}) });
};

// SMS paid from the wallet (2026-10, one wallet per centre): a clinic's or
// hospital's from its own wallet, or the owner's when that does not cover
// it; every other kind from the owner's. Null: neither covers it.
export const spendOnSms = (owner: BizOwner, user: unknown, cost: number) =>
  debitSpending(scopeOfOwner(owner, user), cost);

// what the SMS pages show as the wallet: what a send can be paid from
export const smsBalance = (owner: BizOwner, user: unknown) => spendableBalance(scopeOfOwner(owner, user));

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
  // the tracked link, when the text asks for one
  const wantsLink = /\{(link|review)\}/.test(c.text);
  const token = wantsLink ? c.linkToken || (await newTrackedLink(await orgPublicUrl(owner, base))) : "";
  // every recipient's own text and tracking code, recorded before sending
  // (one per contact: the unique key keeps a restarted send from repeating)
  const outgoing = contacts.map((ct) => {
    const code = randomCode(6);
    const text = messageFor(renderText(c.text, varsFor(ct, info.name, token ? trackedUrl(base, token, code) : "")), base, ct.optCode);
    return { ct, code, text, parts: smsParts(text) };
  });
  const parts = Math.max(...outgoing.map((o) => o.parts));
  const total = outgoing.reduce((n, o) => n + o.parts, 0);
  const price = c.unitPrice || (await unitPrice());
  const fromQuota = await takeQuota(owner, total, await monthlyQuota(owner));
  const fromWallet = total - fromQuota;
  const cost = fromWallet * price;
  let txId: unknown;
  let payer: WalletScope | null = null;
  if (cost > 0) {
    payer = await spendOnSms(owner, info.user, cost);
    if (!payer) return fail("موجودی کیف پول برای این کمپین کافی نیست؛ کیف پول را شارژ کنید", fromQuota);
    txId = (await walletTx(owner, c._id, info.user, -cost, "smsCampaign", payer))._id;
  }
  await BizCampaign.updateOne(
    { _id: c._id },
    {
      $set: {
        recipients: contacts.length,
        parts,
        fromQuota,
        fromWallet,
        unitPrice: price,
        charged: cost,
        transaction: txId,
        ...(token ? { linkToken: token } : {}),
      },
    },
  );
  const from = gateway?.marketingFromNumber || "";
  let sent = 0;
  let failed = 0;
  let unsentParts = 0;
  // a few at a time: the gateway takes one recipient per free-text request
  const queue = [...outgoing];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const row = await BizMessage.create({
        ...own(owner),
        contact: next.ct._id,
        phone: next.ct.phone,
        source: "campaign",
        campaign: c._id,
        dedupeKey: `camp:${c._id}:${next.ct._id}`,
        text: next.text,
        parts: next.parts,
        code: next.code,
      }).catch(() => null);
      // already recorded: sent by an earlier run, never again
      if (!row) {
        unsentParts += next.parts;
        continue;
      }
      const r = await sendOne(next.ct.phone, next.text, from);
      await BizMessage.updateOne(
        { _id: row._id },
        { $set: r.ok ? { status: "sent", sentAt: new Date(), outboxId: r.outboxId } : { status: "failed", reason: "gateway" } },
      );
      if (r.ok) sent++;
      else {
        failed++;
        unsentParts += next.parts;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // what was not sent: the wallet's share back first, then the quota's
  const walletBack = Math.min(unsentParts, fromWallet);
  const refund = walletBack * price;
  // back to the wallet that paid
  if (refund > 0 && payer) {
    await creditScope(payer, refund);
    await walletTx(owner, c._id, info.user, refund, "smsCampaign", payer);
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
    const due = (
      await BizCampaign.find({ status: "Approved", sendAfter: { $lte: new Date() } })
        .sort({ sendAfter: 1 })
        .limit(20)
        .lean<IBizCampaign[]>()
    )
      .filter((c) => inOwnWindow(c.windowFrom, c.windowUntil))
      .slice(0, 5);
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
