// The one AI gate (2026-10): checkAndConsumeAi(req, featureKey) decides
// whether this user may use this AI feature now and counts the use. It
// replaces the scattered checks it grew from - the panel AI's plan module
// and shared daily cap (consumeAi, AppConfig.panelAiDailyLimit), the
// patient assistant's free / Pro allowance (AiDailyUsage) and the finance
// assistant's share of that cap - with the super admin's policy
// (Lib/ai/aiPolicy.ts) over the feature registry (Lib/ai/aiFeatures.ts):
//
//   1. the master switch, then the mode (free / by plan / off), then the
//      feature's own access (free / plan / off);
//   2. who is asking and on which plan: a provider panel's plan modules
//      and its plan's own AI (aiFeatures / aiQuotas on Base*License), a
//      patient's Pro membership (and the Pro plan's AI), staff, admin;
//   3. the limits of their tier (free / paid; a plan's own quota wins):
//      per user per day, per user per Jalali month, per organisation per
//      month - each counted per feature in AiUsage;
//   4. a refusal is an AiGateError: a Persian message translated like any
//      other (Lib/i18n/errorMessages.ts) plus `ai` details the pages use
//      for the locked / limit-reached state (code, reset time, upgrade).
import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import moment from "moment-jalaali";
import AppError from "../AppError";
import AiUsage from "../../Models/AiUsage";
import DoctorProfileLicense from "../../Models/DoctorProfileLicense";
import ClinicProfileLicense from "../../Models/ClinicProfileLicense";
import HospitalProfileLicense from "../../Models/HospitalProfileLicense";
import PharmacyProfileLicense from "../../Models/PharmacyProfileLicense";
import ParaClinicProfileLicense from "../../Models/ParaClinicProfileLicense";
import InsuranceProfileLicense from "../../Models/InsuranceProfileLicense";
import BaseDoctorLicense from "../../Models/BaseDoctorLicense";
import BaseClinicLicense from "../../Models/BaseClinicLicense";
import BaseHospitalLicense from "../../Models/BaseHospitalLicense";
import BasePharmacyLicense from "../../Models/BasePharmacyLicense";
import BaseParaClinicLicense from "../../Models/BaseParaClinicLicense";
import BaseInsuranceLicense from "../../Models/BaseInsuranceLicense";
import { isLicenseExpired } from "../licenseActive";
import { minimalModules } from "../licenseTiers";
import type { LicenseKind } from "../licenseQuote";
import { getProPlan, proStatusOf } from "../patientPro";
import { aiFeature, AiAudience, AiFeatureDef, AiLimitSet, featuresFor, isInternal, isProviderAudience, userFacingAudiences } from "./aiFeatures";
import { AiTier, getAiPolicy } from "./aiPolicy";

// ---------------------------------------------------------------- messages

export const AI_OFF = "این قابلیت هوش مصنوعی در حال حاضر فعال نیست";
export const AI_NOT_IN_PLAN = "این قابلیت در پلن شما نیست؛ برای استفاده، پلن خود را ارتقا دهید";
export const AI_NOT_IN_PRO = "این قابلیت در پلن شما نیست؛ با اشتراک پرو فعال می‌شود";
// the panel AI's message from before the policy (already translated)
export const AI_DAY_LIMIT = "سقف روزانه‌ی درخواست‌های هوش مصنوعی شما پر شده است؛ فردا دوباره تلاش کنید";
export const AI_DAY_LIMIT_UPGRADE =
  "سهمیه‌ی امروز این قابلیت در پلن شما تمام شد؛ فردا دوباره در دسترس است، یا با ارتقای پلن بیشتر استفاده کنید";
export const AI_MONTH_LIMIT = "سقف ماهانه‌ی این قابلیت هوش مصنوعی پر شده است؛ از ابتدای ماه بعد دوباره در دسترس است";
export const AI_MONTH_LIMIT_UPGRADE =
  "سهمیه‌ی این ماه این قابلیت در پلن شما تمام شد؛ از ابتدای ماه بعد دوباره در دسترس است، یا با ارتقای پلن بیشتر استفاده کنید";
export const AI_ORG_MONTH_LIMIT = "سقف ماهانه‌ی این قابلیت برای مجموعه‌ی شما پر شده است؛ از ابتدای ماه بعد دوباره در دسترس است";

export type AiGateCode = "off" | "notInPlan" | "limit";
export type AiLimitScope = "day" | "month" | "orgMonth";

export type AiGateInfo = {
  code: AiGateCode;
  feature: string;
  scope?: AiLimitScope;
  limit?: number;
  used?: number;
  unit?: "request" | "minute";
  // ISO time the limit opens again
  resetAt?: string;
  // where the user buys more (a panel's plans page, or /pro)
  upgrade?: string | null;
};

export class AiGateError extends AppError {
  ai: AiGateInfo;
  constructor(message: string, statusCode: number, ai: AiGateInfo) {
    super(message, statusCode);
    this.ai = ai;
  }
}

// ---------------------------------------------------------------- time

const TEHRAN = 210;
export const tehranDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const jalaliMonth = (d = new Date()) => moment(d).utcOffset(TEHRAN).format("jYYYY-jMM");
const nextDayStart = () => moment().utcOffset(TEHRAN).startOf("day").add(1, "day").toISOString();
const nextMonthStart = () => moment().utcOffset(TEHRAN).startOf("jMonth").add(1, "jMonth").toISOString();

// ---------------------------------------------------------------- who

export type AiSubject = {
  audience: AiAudience;
  // the person (absent for a background job of an organisation)
  user?: string;
  // the organisation a provider panel works for
  org?: { kind: LicenseKind; id: string };
};

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const oid = (v: string) => new mongoose.Types.ObjectId(v);

const PROVIDER_KINDS: LicenseKind[] = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic", "insurance"];

// who is asking, for this feature: the feature's audiences say where to look
export const subjectOf = (req: Request, featureKey: string, org?: { kind: LicenseKind; id: string } | null): AiSubject => {
  const f = aiFeature(featureKey);
  const user = idOf(req.user?._id);
  if (!f) return { audience: "patient", user };
  if (org?.id) return { audience: org.kind, user, org };
  if (f.audiences.includes("admin")) return { audience: "admin", user };
  if (f.audiences.includes("staff")) return { audience: "staff", user };
  const r = req as unknown as Record<string, { _id?: unknown } | undefined>;
  const named = req.params?.name;
  const kinds = named && isProviderAudience(named) ? [named] : PROVIDER_KINDS;
  for (const kind of kinds) {
    if (!f.audiences.includes(kind)) continue;
    const doc = r[kind];
    if (doc?._id) return { audience: kind, user, org: { kind, id: String(doc._id) } };
  }
  return { audience: "patient", user };
};

// ---------------------------------------------------------------- plans

type PlanAi = { aiFeatures?: string[]; aiQuotas?: Record<string, Partial<AiLimitSet>> };
type Holding = { modules: string[]; plan: PlanAi | null; pro: boolean };

const PLAN_MODELS: Record<LicenseKind, { profile: mongoose.Model<any>; base: mongoose.Model<any> }> = {
  doctor: { profile: DoctorProfileLicense, base: BaseDoctorLicense },
  clinic: { profile: ClinicProfileLicense, base: BaseClinicLicense },
  hospital: { profile: HospitalProfileLicense, base: BaseHospitalLicense },
  pharmacy: { profile: PharmacyProfileLicense, base: BasePharmacyLicense },
  paraClinic: { profile: ParaClinicProfileLicense, base: BaseParaClinicLicense },
  insurance: { profile: InsuranceProfileLicense, base: BaseInsuranceLicense },
};

// what the subject holds now: an organisation's plan modules and plan (its
// own unexpired plan, else the default plan, else the free tier's minimum
// - the resolution of each panel's requireLicenseModule), or a patient's
// Pro membership and the Pro plan
const holdingOf = async (s: AiSubject): Promise<Holding> => {
  if (s.org && PLAN_MODELS[s.org.kind] && mongoose.isValidObjectId(s.org.id)) {
    const m = PLAN_MODELS[s.org.kind];
    const lic = await m.profile
      .findOne({ owner: s.org.id })
      .select("modules expiresAt baseLicense")
      .populate("baseLicense", "aiFeatures aiQuotas")
      .lean<{ modules?: string[]; expiresAt?: Date; baseLicense?: PlanAi | null }>();
    if (lic && !isLicenseExpired(lic as never))
      return { modules: lic.modules || [], plan: (lic.baseLicense as PlanAi) || null, pro: false };
    const def = await m.base.findOne({ isDefault: true }).select("modules aiFeatures aiQuotas").lean<PlanAi & { modules?: string[] }>();
    if (def) return { modules: def.modules || [], plan: def, pro: false };
    return { modules: [...(minimalModules[s.org.kind] || [])], plan: null, pro: false };
  }
  if (s.audience === "patient" && s.user) {
    const [status, plan] = await Promise.all([proStatusOf(s.user), getProPlan().catch(() => null)]);
    return { modules: [], plan: status.active ? ((plan as unknown as PlanAi) || null) : null, pro: status.active };
  }
  return { modules: [], plan: null, pro: false };
};

export const UPGRADE_PATH: Record<string, string> = {
  doctor: "/doctorpanel/license",
  clinic: "/clinicpanel/license",
  hospital: "/hospitalpanel/license",
  pharmacy: "/pharmacypanel/license",
  paraClinic: "/paraClinicPanel/license",
  insurance: "/insurancepanel/license",
  patient: "/pro",
};

// ---------------------------------------------------------------- decide

type Decision =
  | { ok: false; error: AiGateError }
  | { ok: true; f: AiFeatureDef; tier: AiTier; limits: AiLimitSet; upgradeable: boolean; upgrade: string | null };

const decide = async (s: AiSubject, key: string, holding?: Holding): Promise<Decision> => {
  const f = aiFeature(key);
  const off = (msg = AI_OFF): Decision => ({
    ok: false,
    error: new AiGateError(msg, 403, { code: "off", feature: key, unit: f?.unit, upgrade: null }),
  });
  if (!f || !f.audiences.includes(s.audience)) return off();
  const policy = await getAiPolicy();
  const fp = policy.features[key];
  if (!policy.enabled || !fp || fp.access === "off") return off();
  const userFacing = userFacingAudiences.includes(s.audience);
  if (userFacing && policy.mode === "off") return off();
  const upgrade = UPGRADE_PATH[s.audience] || null;
  if (isInternal(f)) return { ok: true, f, tier: "free", limits: fp.limits.free, upgradeable: false, upgrade: null };

  const h = holding || (await holdingOf(s));
  const byModule = isProviderAudience(s.audience) && (fp.modules[s.audience] || []).some((m) => h.modules.includes(m));
  const byPlan = !!h.plan?.aiFeatures?.includes(key);
  const byPro = s.audience === "patient" && h.pro && fp.pro;
  const unlocked = byModule || byPlan || byPro;
  if (fp.access === "plan" && policy.mode !== "free" && !unlocked)
    return {
      ok: false,
      error: new AiGateError(s.audience === "patient" ? AI_NOT_IN_PRO : AI_NOT_IN_PLAN, 403, {
        code: "notInPlan",
        feature: key,
        unit: f.unit,
        upgrade,
      }),
    };
  const tier: AiTier = unlocked ? "paid" : "free";
  const own = unlocked ? h.plan?.aiQuotas?.[key] : undefined;
  const pick = (k: keyof AiLimitSet) => {
    const v = Number(own?.[k]);
    return own && own[k] !== undefined && own[k] !== null && Number.isFinite(v) && v >= 0 ? Math.round(v) : fp.limits[tier][k];
  };
  const limits: AiLimitSet = { day: pick("day"), month: pick("month"), orgMonth: pick("orgMonth") };
  // more is on sale: the paid tier allows more than the free one
  const paid = fp.limits.paid;
  const more = (a: number, b: number) => (a === 0 && b > 0) || (a > b && b > 0);
  const upgradeable =
    tier === "free" && !!upgrade && (more(paid.day, limits.day) || more(paid.month, limits.month) || more(paid.orgMonth, limits.orgMonth));
  return { ok: true, f, tier, limits, upgradeable, upgrade };
};

// ---------------------------------------------------------------- count

export type AiTicket = { key: string; units: number; filters: Record<string, unknown>[] };

// the subject of the platform's own budget (content tools)
export const PLATFORM_ID = "000000000000000000000000";

const sumMonth = async (scope: "user" | "org" | "platform", subject: string, key: string) => {
  const rows = await AiUsage.aggregate<{ n: number }>([
    { $match: { scope, subject: oid(subject), feature: key, month: jalaliMonth() } },
    { $group: { _id: null, n: { $sum: "$count" } } },
  ]);
  return rows[0]?.n || 0;
};

// Checks the policy for this subject and feature and counts `units` (1 by
// default; started minutes of audio for speech-to-text). Throws an
// AiGateError when refused. Returns a ticket to give the units back with
// refundAi when the model did not answer.
export const consumeAiFor = async (s: AiSubject, key: string, units = 1): Promise<AiTicket> => {
  const d = await decide(s, key);
  if (!d.ok) throw d.error;
  const n = Math.max(1, Math.round(units));
  const day = tehranDay();
  const month = jalaliMonth();
  const limitError = (scope: AiLimitScope, limit: number, used: number) => {
    const msg =
      scope === "orgMonth"
        ? AI_ORG_MONTH_LIMIT
        : scope === "day"
          ? d.upgradeable
            ? AI_DAY_LIMIT_UPGRADE
            : AI_DAY_LIMIT
          : d.upgradeable
            ? AI_MONTH_LIMIT_UPGRADE
            : AI_MONTH_LIMIT;
    return new AiGateError(msg, 429, {
      code: "limit",
      feature: key,
      scope,
      limit,
      used,
      unit: d.f.unit,
      resetAt: scope === "day" ? nextDayStart() : nextMonthStart(),
      upgrade: d.upgradeable ? d.upgrade : null,
    });
  };
  // the content tools are the platform's own: one budget for the platform
  const platform = s.audience === "admin";
  const user = platform ? PLATFORM_ID : s.user && mongoose.isValidObjectId(s.user) ? s.user : "";
  const scope = platform ? "platform" : "user";
  const org = s.org?.id && mongoose.isValidObjectId(s.org.id) ? s.org : undefined;
  if (d.limits.month && user) {
    const used = await sumMonth(scope, user, key);
    if (used + n > d.limits.month) throw limitError("month", d.limits.month, used);
  }
  if (d.limits.orgMonth && org) {
    const used = await sumMonth("org", org.id, key);
    if (used + n > d.limits.orgMonth) throw limitError("orgMonth", d.limits.orgMonth, used);
  }
  const inc = { $inc: { count: n, requests: 1 } };
  const meta = { month, audience: s.audience, tier: d.tier };
  const filters: Record<string, unknown>[] = [];
  if (user) {
    const filter = { scope, subject: oid(user), feature: key, day };
    const set = { $set: { ...meta, ...(org ? { orgKind: org.kind, org: oid(org.id) } : {}) } };
    if (d.limits.day) {
      if (n > d.limits.day) throw limitError("day", d.limits.day, 0);
      try {
        // the counter only moves while under the limit; a full day makes the
        // upsert's insert hit the unique index
        await AiUsage.findOneAndUpdate({ ...filter, count: { $lte: d.limits.day - n } }, { ...inc, ...set }, { upsert: true, new: true });
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        const row = await AiUsage.findOne(filter).select("count").lean<{ count?: number }>();
        throw limitError("day", d.limits.day, row?.count || 0);
      }
    } else await AiUsage.updateOne(filter, { ...inc, ...set }, { upsert: true });
    filters.push(filter);
  }
  if (org) {
    const filter = { scope: "org", subject: oid(org.id), feature: key, day };
    await AiUsage.updateOne(filter, { ...inc, $set: { ...meta, orgKind: org.kind } }, { upsert: true }).catch(() => undefined);
    filters.push(filter);
  }
  return { key, units: n, filters };
};

// a use the model never answered does not count
export const refundAi = async (ticket?: AiTicket | null) => {
  if (!ticket) return;
  await Promise.all(
    ticket.filters.map((f) =>
      AiUsage.updateOne({ ...f, count: { $gte: ticket.units } }, { $inc: { count: -ticket.units, failed: 1 } }).catch(() => undefined),
    ),
  );
};

// started minutes of an uploaded recording: what the recorder says, unless
// it is far from what the file's size says at the 32 kbps the site's
// recorders use
export const audioMinutes = (req: Request) => {
  const bytes = req.file?.size || req.file?.buffer?.length || 0;
  const bySize = bytes / 4000;
  const told = Number((req.body as Record<string, unknown> | undefined)?.seconds);
  const seconds = Number.isFinite(told) && told > 0 && told >= bySize / 4 && told <= bySize * 1.5 ? told : bySize;
  return Math.max(1, Math.ceil(seconds / 60));
};

// The gate of a request: the subject comes from the request (the panel's
// organisation that useAcl / useDoctor put on it, the patient, the staff
// member). `units` is a number or "audio" (minutes of req.file).
export const checkAndConsumeAi = async (
  req: Request,
  featureKey: string,
  opts: { units?: number | "audio"; org?: { kind: LicenseKind; id: string } | null } = {},
): Promise<AiTicket> => {
  const units = opts.units === "audio" ? audioMinutes(req) : opts.units ?? 1;
  const ticket = await consumeAiFor(subjectOf(req, featureKey, opts.org), featureKey, units);
  (req as unknown as { aiTickets?: AiTicket[] }).aiTickets = [
    ...((req as unknown as { aiTickets?: AiTicket[] }).aiTickets || []),
    ticket,
  ];
  return ticket;
};

// gives back every use this request counted (the answer failed)
export const refundRequestAi = async (req: Request) => {
  const list = (req as unknown as { aiTickets?: AiTicket[] }).aiTickets || [];
  (req as unknown as { aiTickets?: AiTicket[] }).aiTickets = [];
  await Promise.all(list.map((t) => refundAi(t)));
};

// middleware form
export const aiGate =
  (featureKey: string, opts: { units?: number | "audio" } = {}): RequestHandler =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await checkAndConsumeAi(req, featureKey, opts);
      next();
    } catch (err) {
      next(err);
    }
  };

// ---------------------------------------------------------------- status

export type AiFeatureState = {
  key: string;
  group: string;
  unit: "request" | "minute";
  state: "ok" | "off" | "notInPlan" | "limit";
  tier?: AiTier;
  // today's limit and use (0 = unlimited)
  limit?: number;
  used?: number;
  remaining?: number | null;
  monthLimit?: number;
  monthUsed?: number;
  resetAt?: string;
  upgrade?: string | null;
};

// Every feature of the subject's audience with its state, for the pages to
// show, lock or hide their AI tools and the quota left. Nothing is counted.
export const aiFeatureStates = async (s: AiSubject, keys?: string[]): Promise<Record<string, AiFeatureState>> => {
  const list = featuresFor(s.audience).filter((f) => !keys || keys.includes(f.key));
  if (!list.length) return {};
  const holding = isInternal(list[0]) ? undefined : await holdingOf(s);
  const platform = s.audience === "admin";
  const user = platform ? PLATFORM_ID : s.user && mongoose.isValidObjectId(s.user) ? s.user : "";
  const org = s.org?.id && mongoose.isValidObjectId(s.org.id) ? s.org : undefined;
  const month = jalaliMonth();
  const day = tehranDay();
  const [userRows, orgRows] = await Promise.all([
    user
      ? AiUsage.find({ scope: platform ? "platform" : "user", subject: oid(user), month, feature: { $in: list.map((f) => f.key) } }).select("feature day count").lean<{ feature: string; day: string; count: number }[]>()
      : Promise.resolve([]),
    org
      ? AiUsage.aggregate<{ _id: string; n: number }>([
          { $match: { scope: "org", subject: oid(org.id), month } },
          { $group: { _id: "$feature", n: { $sum: "$count" } } },
        ])
      : Promise.resolve([]),
  ]);
  const out: Record<string, AiFeatureState> = {};
  for (const f of list) {
    const d = await decide(s, f.key, holding);
    if (!d.ok) {
      out[f.key] = { key: f.key, group: f.group, unit: f.unit, state: d.error.ai.code === "notInPlan" ? "notInPlan" : "off", upgrade: d.error.ai.upgrade ?? null };
      continue;
    }
    const mine = userRows.filter((r) => r.feature === f.key);
    const used = mine.filter((r) => r.day === day).reduce((a, r) => a + (r.count || 0), 0);
    const monthUsed = mine.reduce((a, r) => a + (r.count || 0), 0);
    const orgUsed = orgRows.find((r) => r._id === f.key)?.n || 0;
    let state: AiFeatureState["state"] = "ok";
    let resetAt: string | undefined;
    if (d.limits.orgMonth && orgUsed >= d.limits.orgMonth) {
      state = "limit";
      resetAt = nextMonthStart();
    } else if (d.limits.month && monthUsed >= d.limits.month) {
      state = "limit";
      resetAt = nextMonthStart();
    } else if (d.limits.day && used >= d.limits.day) {
      state = "limit";
      resetAt = nextDayStart();
    }
    out[f.key] = {
      key: f.key,
      group: f.group,
      unit: f.unit,
      state,
      tier: d.tier,
      limit: d.limits.day,
      used,
      remaining: d.limits.day ? Math.max(0, d.limits.day - used) : null,
      monthLimit: d.limits.month,
      monthUsed,
      resetAt,
      upgrade: d.upgradeable ? d.upgrade : null,
    };
  }
  return out;
};

// whether the feature may be used at all (policy and plan; limits aside):
// the copilot hides the tools of a feature that is not
export const aiFeatureOpen = async (s: AiSubject, key: string) => (await decide(s, key)).ok;

// a background job of an organisation (no request): the policy and the
// organisation's monthly limit, counted under the organisation
export const consumeOrgAi = (kind: LicenseKind, orgId: unknown, key: string) =>
  consumeAiFor({ audience: kind, org: { kind, id: idOf(orgId) } }, key);

// the platform's content tools (translation, medical texts): the policy and
// the platform's budget; `by` is the admin who started it, if any
export const consumePlatformAi = (key: string) => consumeAiFor({ audience: "admin" }, key);
