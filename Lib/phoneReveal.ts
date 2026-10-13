// "Show phone number" on the public profiles (2026-10). Paziresh24, Doctoreto
// and DrDr hide a practice's number behind «نمایش شماره» and count every
// click: the number stops being scraped by bots and copied into directories,
// and the provider sees how many patients called from the site (Doctolib /
// Docplanner sell that "calls from your profile" figure in their pro tools).
// Here:
//  - the profile responses (doctor, clinic, hospital, pharmacy, lab) carry
//    no number at all, only `phoneReveal: { count, token }` (hidePhones);
//  - POST /public/phone/:kind/:id answers with the numbers when the page's
//    signed token, the per-IP / per-visitor budget and the bot check pass,
//    and writes a PhoneReveal (Models/PhoneReveal.ts) for each answer;
//  - the numbers are the ones the automatic FAQ used to word (each office's
//    / department's line with its name, then the profile's own), never the
//    panel account's mobile (Lib/contactLinks.ts publicPhones).
import crypto from "crypto";
import { Request } from "express";
import mongoose, { isValidObjectId } from "mongoose";
import * as env from "./Env";
import { PublicPhone, publicPhones } from "./contactLinks";
import { PhoneRevealDevice, PhoneRevealKind, phoneRevealKinds } from "../Models/PhoneReveal";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import User from "../Models/User";
import Clinic from "../Models/Clinic";
import ClinicDepartment from "../Models/ClinicDepatment";
import Hospital from "../Models/Hospital";
import HospitalDepartment from "../Models/HospitalDepartment";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";

export const isPhoneRevealKind = (v: unknown): v is PhoneRevealKind =>
  typeof v === "string" && (phoneRevealKinds as readonly string[]).includes(v);

// ------------------------------------------------------------ the page token

// A page carries a token signed for its profile; the reveal endpoint takes
// only a fresh one, so a script cannot walk ids without loading each page.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const sign = (payload: string) =>
  crypto.createHmac("sha256", `phone-reveal:${env.JWT_SECRET}`).update(payload).digest("base64url").slice(0, 24);

export const phoneRevealToken = (kind: PhoneRevealKind, id: unknown, now = Date.now()) => {
  const at = now.toString(36);
  return `${at}.${sign(`${kind}:${String(id)}:${at}`)}`;
};

export const verifyPhoneRevealToken = (kind: PhoneRevealKind, id: string, token: unknown, now = Date.now()) => {
  if (typeof token !== "string" || token.length > 64) return false;
  const [at, sig] = token.split(".");
  if (!at || !sig) return false;
  const issued = parseInt(at, 36);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > TOKEN_TTL_MS) return false;
  const expected = sign(`${kind}:${id}:${at}`);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
};

// ------------------------------------------------------------ visitors

export const clientIp = (req: Request) =>
  (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";

// never the IP itself: a keyed hash (rate limits, unique counts)
export const ipHashOf = (ip: string) =>
  crypto.createHmac("sha256", `ip:${env.JWT_SECRET}`).update(ip).digest("base64url").slice(0, 16);

// crawlers and scripts get no number (a browser always sends its own UA)
const BOT_UA =
  /bot|crawl|spider|slurp|scrap|headless|phantom|puppeteer|playwright|selenium|curl|wget|python|httpclient|okhttp|java\/|go-http|node-fetch|axios|libwww|lighthouse|preview/i;
export const looksLikeBot = (req: Request) => {
  const ua = String(req.headers["user-agent"] || "");
  return !ua || ua.length < 20 || BOT_UA.test(ua);
};

export const deviceOf = (req: Request): PhoneRevealDevice => {
  const ua = String(req.headers["user-agent"] || "");
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
};

// a fixed-window budget per key, kept in memory (one process, like the map
// gateway's, Controllers/mapController.ts mapRateLimit)
const buckets = new Map<string, { at: number; n: number }>();
export const overBudget = (key: string, max: number, windowMs: number, now = Date.now()) => {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.at > windowMs) {
    if (buckets.size > 50_000) buckets.clear();
    buckets.set(key, { at: now, n: 1 });
    return false;
  }
  bucket.n += 1;
  return bucket.n > max;
};

// ------------------------------------------------------------ the numbers

const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v ?? "");
const accountPhone = async (user: unknown) => {
  const id = idOf(user);
  if (!isValidObjectId(id)) return undefined;
  return (await User.findById(id).select("phone").lean<{ phone?: string }>())?.phone;
};

type Row = { name?: unknown; phone?: unknown; translations?: unknown };

// the public numbers of one profile, as its page used to show them; null =
// no such public profile
export const phonesOf = async (kind: PhoneRevealKind, id: string): Promise<PublicPhone[] | null> => {
  if (!isValidObjectId(id)) return null;
  const _id = new mongoose.Types.ObjectId(id);
  switch (kind) {
    case "doctor": {
      const doctor = await DoctorProfile.findOne({ _id, active: true })
        .select("landLine user")
        .lean<{ landLine?: string; user?: unknown }>();
      if (!doctor) return null;
      const [offices, mobile] = await Promise.all([
        Office.find({ doctor: _id, active: true }).sort({ order: 1, _id: 1 }).select("name tel translations").lean<Row[]>(),
        accountPhone(doctor.user),
      ]);
      return publicPhones(
        [
          ...offices.map((o) => ({
            name: o.name,
            phone: (o as { tel?: unknown }).tel,
            translations: o.translations,
          })),
          { phone: doctor.landLine },
        ],
        [mobile],
      );
    }
    case "clinic":
    case "hospital": {
      const node =
        kind === "clinic"
          ? await Clinic.findOne({ _id, active: true }).select("phone user").lean<{ phone?: string; user?: unknown }>()
          : await Hospital.findOne({ _id, isActive: true }).select("phone user").lean<{ phone?: string; user?: unknown }>();
      if (!node) return null;
      const [departments, mobile] = await Promise.all([
        kind === "clinic"
          ? ClinicDepartment.find({ clinic: _id, active: true }).sort({ order: 1, _id: 1 }).select("name phone translations").lean<Row[]>()
          : HospitalDepartment.find({ hospital: _id, active: true }).sort({ order: 1, _id: 1 }).select("name phone translations").lean<Row[]>(),
        accountPhone(node.user),
      ]);
      return publicPhones([{ phone: node.phone }, ...departments], [mobile]);
    }
    case "pharmacy":
    case "paraClinic": {
      const node =
        kind === "pharmacy"
          ? await Pharmacy.findOne({ _id, active: true }).select("phone user").lean<{ phone?: string; user?: unknown }>()
          : await ParaClinic.findOne({ _id, active: true }).select("phone user").lean<{ phone?: string; user?: unknown }>();
      if (!node) return null;
      return publicPhones([{ phone: node.phone }], [await accountPhone(node.user)]);
    }
  }
};

// ------------------------------------------------------------ the page

// every key that holds a number on a profile response: the profile's own
// (phone / landLine), an office's (tel), a department's (phone), the FAQ
// facts' (autoFaq.facts.phone, its hash) and the list made for the FAQ
const PHONE_KEYS = new Set(["phone", "tel", "landLine", "publicPhones"]);
export const scrubPhones = (value: unknown, depth = 0): void => {
  if (!value || typeof value !== "object" || depth > 30) return;
  if (Array.isArray(value)) {
    for (const item of value) scrubPhones(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PHONE_KEYS.has(key)) delete record[key];
    else scrubPhones(record[key], depth + 1);
  }
};

// (`ticket`, not `token`: a "token" key is swept from public responses,
// Lib/stripPrivateFields.ts)
export type PhoneRevealHandle = { kind: PhoneRevealKind; count: number; ticket: string };

// Takes every number out of a profile response (in place) and returns what
// the page needs to offer «نمایش شماره تماس»: how many numbers there are and
// a token for the reveal endpoint. A doctor's own answer to the "phone"
// question of the automatic FAQ is dropped too (it could hold the number).
// (Works on a plain copy: mongoose documents are serialised first.)
export const hidePhones = <T>(
  kind: PhoneRevealKind,
  id: unknown,
  input: T,
  phones: PublicPhone[] | null,
): T & { phoneReveal: PhoneRevealHandle } => {
  const body = JSON.parse(JSON.stringify(input ?? {})) as T;
  scrubPhones(body);
  const faq = (body as { autoFaq?: { overrides?: { key?: string; customAnswer?: string }[] } | null }).autoFaq;
  if (faq && Array.isArray(faq.overrides))
    for (const o of faq.overrides) if (o?.key === "phone") delete o.customAnswer;
  const count = Array.isArray(phones) ? phones.length : 0;
  return Object.assign(body as object, {
    phoneReveal: { kind, count, ticket: phoneRevealToken(kind, id) },
  }) as T & { phoneReveal: PhoneRevealHandle };
};
