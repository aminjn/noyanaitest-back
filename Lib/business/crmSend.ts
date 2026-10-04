import crypto from "crypto";
import mongoose from "mongoose";
import ShortLink from "../../Models/ShortLink";
import BizMessage from "../../Models/BizMessage";
import Reservation from "../../Models/Reservation";
import SmsGatewaySettings from "../../Models/SmsGatewaySettings";
import DoctorProfile from "../../Models/DoctorProfile";
import Pharmacy from "../../Models/Pharmacy";
import Clinic from "../../Models/Clinic";
import Hospital from "../../Models/Hospital";
import ParaClinic from "../../Models/Paraclinic";
import Insurance from "../../Models/Insurance";
import * as env from "../Env";
import { getAppConfig } from "../appConfig";
import { getSmsGateway } from "../sendSms";
import { siteDefaultLocale } from "../locales";
import { translateNotificationText } from "../i18n/translateNotification";
import { BizOwner } from "./coa";
import { visitsWhere } from "./crm";

// The CRM's SMS plumbing (2026-10), shared by campaigns, automations and the
// one-off send from a contact's page: the template variables, the tracked
// link, the opt-out footer, one free-text send from the advertising line,
// and the click / booking attribution of each message (Models/BizMessage.ts).

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const DAY = 864e5;

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

// the variables a template may use
export const SMS_VARS = ["name", "firstName", "org", "link", "review", "lastVisit"] as const;
export type SmsVars = Partial<Record<(typeof SMS_VARS)[number], string>>;

export const renderText = (text: string, vars: SmsVars) =>
  text
    .replace(/\{(\w+)\}/g, (all, k: string) => ((SMS_VARS as readonly string[]).includes(k) ? vars[k as keyof SmsVars] ?? "" : all))
    .replace(/[ \t]{2,}/g, " ")
    .trim();

// «لغو۱۱»: the opt-out keyword the regulator asks of every advertising SMS
// (the operator's own block on a reply of 11), followed by the patient's
// own link that also records it here (this centre or all of Noyan)
const OPTOUT_WORD = "لغو۱۱";
export const siteBase = async () => {
  const cfg = await getAppConfig();
  return (cfg.siteBaseUrl || "").replace(/\/+$/, "");
};
export const optOutFooter = (base: string, code: string) =>
  `${translateNotificationText(OPTOUT_WORD, siteDefaultLocale())} ${base}/o/${code}`;
// the text a recipient gets: the owner's (filled) text, then the footer
export const messageFor = (text: string, base: string, optCode: string) => `${text.trim()}\n${optOutFooter(base, optCode)}`;

// a date in the site's language (Jalali in Persian)
export const smsDate = (d?: Date | string | null) => {
  if (!d) return "";
  const loc = siteDefaultLocale();
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  return new Intl.DateTimeFormat(loc === "fa" ? "fa-IR" : loc, { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tehran" }).format(t);
};

// ---------------------------------------------------------------- links

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const randomCode = (n = 6) => {
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join("");
};

const ORG_PATH: Record<string, { model: mongoose.Model<any>; path: string }> = {
  doctor: { model: DoctorProfile, path: "dr" },
  clinic: { model: Clinic, path: "clinic" },
  hospital: { model: Hospital, path: "hospital" },
  pharmacy: { model: Pharmacy, path: "pharmacy" },
  paraClinic: { model: ParaClinic, path: "paraClinic" },
  insurance: { model: Insurance, path: "insurance" },
};

// the owner's public page (where a patient books or orders)
export const orgPublicUrl = async (owner: BizOwner, base: string) => {
  const c = ORG_PATH[owner.kind];
  if (!c || !owner.id) return base || "/";
  const o = await c.model.findById(owner.id).select("slug").lean<{ slug?: string }>();
  return `${base}/${c.path}/${encodeURIComponent(o?.slug || String(owner.id))}`;
};

// One short link (Models/ShortLink.ts, the admin's /l/<token> links) per
// campaign or automation, pointing at the owner's page; each recipient gets
// /l/<token>-<code>, so the click is theirs.
export const newTrackedLink = async (target: string) => {
  for (let i = 0; i < 5; i++) {
    const token = `c${randomCode(5)}`;
    const ok = await ShortLink.create({ token, target, source: "crm" }).then(
      () => true,
      () => false,
    );
    if (ok) return token;
  }
  return "";
};
export const trackedUrl = (base: string, token: string, code: string) => `${base}/l/${token}-${code}`;

// GET /public/shortlink/<token>-<code>: the click of one recipient (counted
// once per message as "clicked", every time in `clicks`); the message's own
// target when it has one (the review link of a visit)
export const resolveTrackedClick = async (raw: string) => {
  const m = raw.match(/^(.+)-([A-Za-z0-9]{6})$/);
  if (!m) return null;
  const link = await ShortLink.findOne({ token: m[1], source: "crm" }).lean();
  if (!link) return null;
  const msg = await BizMessage.findOneAndUpdate(
    { code: m[2] },
    { $inc: { clicks: 1 }, $min: { clickedAt: new Date() } },
    { new: false },
  ).lean();
  if (msg && !msg.clicks && msg.campaign) {
    const BizCampaign = mongoose.model("BizCampaign");
    await BizCampaign.updateOne({ _id: msg.campaign }, { $inc: { clicks: 1 } }).catch(() => {});
  }
  return { ...link, target: msg?.target || link.target };
};

// ---------------------------------------------------------------- send

// One free-text SMS from the advertising line (IPPanel "webservice" send).
// With no gateway token (development) it is printed, not sent.
export const sendOne = async (to: string, message: string, from?: string): Promise<{ ok: boolean; outboxId?: string }> => {
  const gateway = await getSmsGateway();
  const line = from ?? ((await SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean())?.marketingFromNumber || "");
  if (env.NODE_ENV === "development" || !gateway.token) {
    console.log(`[SMS crm] from=${line || "-"} to=${to}: ${message}`);
    return { ok: true };
  }
  try {
    const res = await fetch(gateway.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: gateway.token },
      body: JSON.stringify({ sending_type: "webservice", from_number: line, message, params: { recipients: [to] } }),
    });
    const body = (await res.json().catch(() => null)) as { meta?: { status?: boolean }; data?: { message_outbox_ids?: number[] } } | null;
    const id = body?.data?.message_outbox_ids?.[0];
    return { ok: res.ok && !!body?.meta?.status, outboxId: id !== undefined ? String(id) : undefined };
  } catch (err) {
    console.log(`[SMS crm] to=${to} failed:`, err);
    return { ok: false };
  }
};

// ---------------------------------------------------------------- results

// A booking made within 14 days of a sent message (by the contact's account,
// with this owner) is the message's; worked out when results are read, so
// the booking flow itself is untouched. Returns how many were newly found.
export const attributeBookings = async (owner: BizOwner, filter: Record<string, unknown>) => {
  const where = await visitsWhere(owner);
  if (!where) return 0;
  const msgs = await BizMessage.find({ ...filter, status: "sent", bookedAt: { $exists: false }, sentAt: { $gte: new Date(Date.now() - 60 * DAY) } })
    .select("contact sentAt campaign")
    .populate("contact", "user")
    .limit(5000)
    .lean<{ _id: unknown; sentAt: Date; campaign?: unknown; contact?: { user?: unknown } }[]>();
  let found = 0;
  for (const m of msgs) {
    const user = m.contact?.user;
    if (!user) continue;
    const r = await Reservation.findOne({
      ...where,
      user: oid(user),
      createdAt: { $gte: m.sentAt, $lte: new Date(+new Date(m.sentAt) + 14 * DAY) },
      status: { $ne: "cancelled" },
    })
      .select("createdAt")
      .lean<{ createdAt: Date }>();
    if (!r) continue;
    const res = await BizMessage.updateOne({ _id: m._id, bookedAt: { $exists: false } }, { $set: { bookedAt: r.createdAt } });
    if (res.modifiedCount) {
      found++;
      if (m.campaign) await mongoose.model("BizCampaign").updateOne({ _id: m.campaign }, { $inc: { bookings: 1 } }).catch(() => {});
    }
  }
  return found;
};
