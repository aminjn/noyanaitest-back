import { notifyWithSms } from "../../Services/notificationSmsService";
import mongoose from "mongoose";
import BizCampaign, { IBizAudience, IBizCampaign } from "../../Models/BizCampaign";
import BizContact from "../../Models/BizContact";
import SmsOptOut from "../../Models/SmsOptOut";
import { creditScope, debitSpending, scopeOfOwner, scopeOfRow, scopeTxFields, spendableBalance, WalletScope } from "../walletScope";
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
import { getSmsGateway } from "../sendSms";
import { notifyUserAlertSubscribers } from "../../Services/userAlertService";
import { BizOwner } from "./coa";
import BizMessage from "../../Models/BizMessage";
import BizConsentLog from "../../Models/BizConsentLog";
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
import { DEFAULT_SMS_POLICY, loadSmsPolicy, smsPolicy } from "../smsPolicy";
import { addDaysYmd, fromTehranWallClock, startOfTehranDay, tehranParts } from "../tehranTime";

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

const CAP_ERROR = "این کمپین از سقف روزانه‌ی ارسال پیامک بیشتر است؛ مخاطبان را کمتر کنید";

const EDITABLE = ["Draft", "Rejected"];

export const submitCampaign = async (owner: BizOwner, id: unknown) => {
  const c = await BizCampaign.findOne({ ...own(owner), _id: id }).lean<IBizCampaign>();
  if (!c) throw new AppError("کمپین پیدا نشد", 404);
  if (!EDITABLE.includes(c.status)) throw new AppError("این کمپین قبلاً فرستاده شده است", 400);
  const e = await estimate(owner, c.text, c.audience);
  if (!e.recipients) throw new AppError("هیچ مخاطبی با این فیلتر پیدا نشد", 400);
  if (!e.affordable) throw new AppError("موجودی کیف پول برای این کمپین کافی نیست؛ کیف پول را شارژ کنید", 400);
  // a campaign is never split across days: one larger than the daily cap
  // can never go out
  const cap = smsPolicy().dailyCap;
  if (cap && e.recipients > cap) throw new AppError(CAP_ERROR, 400);
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

// Tehran wall-clock: campaigns go out only inside the super admin's send
// window (Lib/smsPolicy.ts, 08:00-21:00 by default - the quiet hours are
// the rest of the day), narrowed by the campaign's own window. An own
// window that falls wholly outside the platform's uses the platform's.
// SEND_FROM / SEND_UNTIL are only the defaults of a new campaign's window.
export const SEND_FROM = DEFAULT_SMS_POLICY.from;
export const SEND_UNTIL = DEFAULT_SMS_POLICY.until;
export const platformWindow = () => {
  const p = smsPolicy();
  return { from: p.from, until: p.until };
};
const bounds = (wFrom?: number, wUntil?: number) => {
  const p = smsPolicy();
  const a = Math.max(p.from, Number.isFinite(wFrom) ? Number(wFrom) : p.from);
  const b = Math.min(p.until, Number.isFinite(wUntil) ? Number(wUntil) : p.until);
  return a < b ? { a, b } : { a: p.from, b: p.until };
};
const isOpen = (d: Date, a: number, b: number) => {
  const m = tehranParts(d).minutes;
  return m >= a * 60 && m < b * 60;
};
export const inOwnWindow = (wFrom?: number, wUntil?: number, d = new Date()) => {
  const { a, b } = bounds(wFrom, wUntil);
  return isOpen(d, a, b);
};
export const inWindow = (d = new Date()) => inOwnWindow(undefined, undefined, d);
// the next moment the window is open: `from` itself when it is, else the
// window's first minute today or tomorrow (Tehran)
export const nextWindow = (from = new Date(), wFrom?: number, wUntil?: number) => {
  const { a, b } = bounds(wFrom, wUntil);
  if (isOpen(from, a, b)) return from;
  const p = tehranParts(from);
  return fromTehranWallClock(p.minutes < a * 60 ? p.ymd : addDaysYmd(p.ymd, 1), a * 60);
};

// The super admin's daily cap per provider (0 = none): messages recorded
// today (Tehran) for this owner, of every kind - campaigns, automations,
// sequences and one-off sends
export const sentToday = (owner: BizOwner) =>
  BizMessage.countDocuments({ ...own(owner), status: { $in: ["queued", "sent"] }, createdAt: { $gte: startOfTehranDay() } });
export const dailyLeft = async (owner: BizOwner) => {
  const cap = smsPolicy().dailyCap;
  if (!cap) return Number.POSITIVE_INFINITY;
  return Math.max(0, cap - (await sentToday(owner)));
};

// the super admin approves (the queue's other actions - reject with a
// reason, reopen - are the generic ones of Controllers/adminRequestsController.ts)
export const approveCampaign = async (id: unknown, adminId?: unknown) => {
  const gateway = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean();
  if (!gateway?.marketingFromNumber && env.NODE_ENV !== "development")
    throw new AppError("شماره‌ی خط تبلیغاتی در تنظیمات پیامک ثبت نشده است", 400);
  // outside development a send with no gateway token cannot leave
  if (env.NODE_ENV !== "development" && !(await getSmsGateway()).token)
    throw new AppError("توکن درگاه پیامک در تنظیمات پیامک ثبت نشده است", 400);
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
      message: `کمپین «${c.name}» تأیید شد و در بازه‌ی مجاز ارسال فرستاده می‌شود.`,
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

// What one campaign moved through the wallet so far: its own Transaction
// rows (the charge negative, refunds positive) and the wallet that paid.
const walletMoves = async (campaignId: unknown) => {
  const rows = await Transaction.find({ smsCampaign: campaignId })
    .select("amount user centreWallet")
    .lean<{ amount: number; user?: unknown; centreWallet?: unknown }[]>();
  const charged = rows.filter((r) => r.amount < 0).reduce((n, r) => n - r.amount, 0);
  const refunded = rows.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0);
  const charge = rows.find((r) => r.amount < 0);
  return { charged, refunded, payer: charge ? await scopeOfRow(charge) : null };
};

// Closes a campaign that is Sending. Sending -> Sent is claimed first, so
// what was not sent is given back exactly once, whichever path gets here
// (the send itself, or the recovery after a restart). A message recorded
// but never answered by the gateway counts as failed and is paid back.
// The wallet's share is given back first, then the plan quota's, worked
// out from the campaign's own Transaction rows (so a charge made just
// before a crash is still found).
const finishCampaign = async (c: IBizCampaign, owner: BizOwner, user?: unknown, simulated = false) => {
  const fin = await BizCampaign.findOneAndUpdate(
    { _id: c._id, status: "Sending" },
    { $set: { status: "Sent", finishedAt: new Date(), ...(simulated ? { simulated: true } : {}) } },
    { new: true },
  ).lean<IBizCampaign>();
  if (!fin) return;
  await BizMessage.updateMany({ campaign: c._id, status: "queued" }, { $set: { status: "failed", reason: "interrupted" } });
  const groups = await BizMessage.aggregate<{ _id: string; n: number; parts: number }>([
    { $match: { campaign: fin._id } },
    { $group: { _id: "$status", n: { $sum: 1 }, parts: { $sum: "$parts" } } },
  ]);
  const by = (st: string) => groups.find((g) => g._id === st) || { n: 0, parts: 0 };
  const price = fin.unitPrice || 0;
  const money = await walletMoves(fin._id);
  const walletParts = price > 0 ? Math.round(money.charged / price) : 0;
  const backAlready = price > 0 ? Math.round(money.refunded / price) : 0;
  const quotaParts = fin.fromQuota || 0;
  const unsent = Math.max(0, quotaParts + walletParts - by("sent").parts);
  const walletBack = Math.max(0, Math.min(unsent, walletParts - backAlready));
  const refund = walletBack * price;
  if (refund > 0 && money.payer) {
    await creditScope(money.payer, refund);
    await walletTx(owner, fin._id, user || money.payer.user, refund, "smsCampaign", money.payer);
  }
  await giveQuota(owner, Math.min(unsent - walletBack, quotaParts));
  await BizCampaign.updateOne(
    { _id: fin._id },
    {
      $set: {
        sentCount: by("sent").n,
        failedCount: by("failed").n,
        charged: money.charged,
        refunded: money.refunded + (money.payer ? refund : 0),
      },
    },
  );
};

// Charge, send, give back what was not sent. Claimed atomically, so two
// sweeps never send one campaign twice.
const runOne = async (c: IBizCampaign) => {
  const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
  // the daily cap: a campaign is never split, so one that does not fit in
  // what is left of today waits for tomorrow's window
  const cap = smsPolicy().dailyCap;
  if (cap) {
    const n = (await audienceContacts(owner, c.audience)).length;
    if (n <= cap && n > (await dailyLeft(owner))) {
      const tomorrow = fromTehranWallClock(addDaysYmd(tehranParts().ymd, 1), 0);
      await BizCampaign.updateOne({ _id: c._id, status: "Approved" }, { $set: { sendAfter: nextWindow(tomorrow, c.windowFrom, c.windowUntil) } });
      return;
    }
  }
  const claimed = await BizCampaign.findOneAndUpdate(
    { _id: c._id, status: "Approved" },
    { $set: { status: "Sending", startedAt: new Date() } },
    { new: true },
  ).lean<IBizCampaign>();
  if (!claimed) return;
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
  if (cap && contacts.length > cap) return fail(CAP_ERROR);
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
  if (cost > 0) {
    const payer = await spendOnSms(owner, info.user, cost);
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
  let simulated = false;
  // a few at a time: every recipient's text differs (its own opt-out and
  // tracked link), so the gateway gets one recipient per request
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
      if (!row) continue;
      const r = await sendOne(next.ct.phone, next.text, from);
      if (r.simulated) simulated = true;
      await BizMessage.updateOne(
        { _id: row._id },
        {
          $set: r.ok
            ? { status: "sent", sentAt: new Date(), outboxId: r.outboxId, ...(r.simulated ? { reason: "simulated" } : {}) }
            : { status: "failed", reason: r.reason || "gateway" },
        },
      );
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await finishCampaign(c, owner, info.user, simulated);
};

let running = false;
export const runCampaignSweep = async () => {
  if (running) return;
  await loadSmsPolicy();
  if (!inWindow()) return;
  running = true;
  try {
    const due = (
      await BizCampaign.find({ status: "Approved", sendAfter: { $lte: new Date() } })
        .sort({ sendAfter: 1 })
        .limit(100)
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
  loadSmsPolicy().catch(() => {});
  setInterval(() => runCampaignSweep().catch((err) => console.log("[campaign] sweep failed:", err)), 60_000);
  // a campaign left half-sent by a restart is closed with what its
  // messages say - nothing is sent twice, and what did not go out is
  // given back once (finishCampaign)
  BizCampaign.find({ status: "Sending", startedAt: { $lt: new Date(Date.now() - 30 * 60_000) } })
    .limit(200)
    .lean<IBizCampaign[]>()
    .then(async (rows) => {
      for (const c of rows) {
        const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
        await finishCampaign(c, owner).catch((err) => console.log(`[campaign] ${c._id} recovery failed:`, err));
      }
    })
    .catch(() => {});
};

// ---------------------------------------------------------------- opt-out

export const optOutInfo = async (code: string) => {
  const contact = await BizContact.findOne({ optCode: code }).select("ownerKind ownerId smsOptOut phone").lean();
  if (!contact) return null;
  const info = await orgInfo({ kind: contact.ownerKind, id: String(contact.ownerId) }).catch(() => null);
  const all = !!(await SmsOptOut.exists({ phone: contact.phone }));
  return { name: info?.name || "", optedOut: contact.smsOptOut, all };
};

// The patient's «لغو» from the link in an SMS: this centre only, or every
// centre on Noyan. Each real change is written to the append-only consent
// log (Models/BizConsentLog.ts) with the IP and browser, so the opt-out can
// be shown if a centre or the regulator asks.
export const optOut = async (code: string, scope: "owner" | "all", meta: { ip?: string; userAgent?: string } = {}) => {
  const before = await BizContact.findOne({ optCode: code })
    .select("ownerKind ownerId phone user source via smsOptOut")
    .lean<{ _id: unknown; ownerKind: BizOwnerKind; ownerId: unknown; phone: string; user?: unknown; source: string; via?: string; smsOptOut?: boolean }>();
  if (!before) throw new AppError("این لینک معتبر نیست", 404);
  const wasAll = !!(await SmsOptOut.exists({ phone: before.phone }));
  await BizContact.updateOne({ _id: before._id, smsOptOut: { $ne: true } }, { $set: { smsOptOut: true, optOutAt: new Date() } });
  if (scope === "all") await SmsOptOut.updateOne({ phone: before.phone }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  const actions = [...(before.smsOptOut ? [] : ["smsOptOut" as const]), ...(scope === "all" && !wasAll ? ["smsOptOutAll" as const] : [])];
  if (actions.length) {
    const [{ sourceOf }, info] = await Promise.all([
      import("./crmService/link"),
      orgInfo({ kind: before.ownerKind, id: String(before.ownerId) } as BizOwner).catch(() => null),
    ]);
    await BizConsentLog.insertMany(
      actions.map((action) => ({
        ...(before.user ? { user: before.user } : {}),
        contact: before._id,
        ownerKind: before.ownerKind,
        ownerId: before.ownerId,
        ownerName: info?.name || "",
        action,
        actor: "patient",
        source: sourceOf(before as any),
        phone: before.phone,
        ...(meta.ip ? { ip: meta.ip.slice(0, 60) } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 400) } : {}),
        at: new Date(),
      })),
    ).catch((err) => console.log("[campaign] opt-out log failed:", err));
  }
  return optOutInfo(code);
};
