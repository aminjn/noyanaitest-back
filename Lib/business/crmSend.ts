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
import { gatewayPhone, getSmsGateway } from "../sendSms";
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

// GSM-7 or not: a Persian text is UCS-2 (70 a part, 67 when split, counted
// in UTF-16 units - an emoji takes two), a Latin one GSM-7 (160, 153 when
// split; ^ { } \ [ ] ~ | € take two)
const GSM = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
const GSM_EXT = /[\^{}\\[\]~|€]/g;
export const smsLength = (text: string) => {
  const ucs = !GSM.test(text);
  return { ucs, len: ucs ? text.length : text.length + (text.match(GSM_EXT)?.length || 0) };
};
export const smsParts = (text: string) => {
  const { ucs, len } = smsLength(text);
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

// One free-text SMS from the advertising line (IPPanel Edge "webservice"
// send: one message to the listed recipients - every CRM message is
// personal, with its own opt-out and tracked link, so one recipient a
// request). In development it is only printed (`simulated`: the caller
// records and charges it as sent, so the money flow can be tried end to
// end). Anywhere else a missing token or advertising line fails the send
// (the caller pays it back) instead of pretending it left. A rate limit
// (429) or a connection that never opened is tried again twice; any other
// answer is final, so a message the gateway took is never sent twice.
export type SendOneResult = { ok: boolean; outboxId?: string; simulated?: boolean; reason?: string };
// errors raised before the request reached the gateway
const RETRYABLE_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sendOne = async (to: string, message: string, from?: string): Promise<SendOneResult> => {
  const gateway = await getSmsGateway();
  const line = from || ((await SmsGatewaySettings.findOne({ singleton: "SINGLETON" }).select("marketingFromNumber").lean())?.marketingFromNumber || "");
  if (env.NODE_ENV === "development") {
    console.log(`[SMS crm] (simulated) from=${line || "-"} to=${gatewayPhone(to)}: ${message}`);
    return { ok: true, simulated: true };
  }
  if (!gateway.token) return { ok: false, reason: "noGateway" };
  if (!line) return { ok: false, reason: "noLine" };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(gateway.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: gateway.token },
        body: JSON.stringify({ sending_type: "webservice", from_number: line, message, params: { recipients: [gatewayPhone(to)] } }),
      });
      if (res.status === 429 && attempt < 2) {
        await wait(1000 * 3 ** attempt);
        continue;
      }
      const body = (await res.json().catch(() => null)) as { meta?: { status?: boolean; message?: string }; data?: { message_outbox_ids?: number[] } } | null;
      const id = body?.data?.message_outbox_ids?.[0];
      const ok = res.ok && !!body?.meta?.status;
      if (!ok) console.log(`[SMS crm] to=${to} rejected: ${res.status} ${body?.meta?.message || ""}`);
      return { ok, outboxId: id !== undefined ? String(id) : undefined, ...(ok ? {} : { reason: "gateway" }) };
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code || "";
      if (RETRYABLE_NET.has(code) && attempt < 2) {
        await wait(1000 * 3 ** attempt);
        continue;
      }
      console.log(`[SMS crm] to=${to} failed:`, err);
      return { ok: false, reason: "gateway" };
    }
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
