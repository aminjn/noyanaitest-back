// «سیاست هوش مصنوعی» (2026-10): the super admin's rules for every AI feature
// (Lib/ai/aiFeatures.ts), stored in Models/AiPolicy.ts and read through a
// short cache. Enforced by Lib/ai/aiGate.ts.
//
//   enabled   the master switch (off = no AI anywhere)
//   mode      free = plan gates lifted for everyone (limits stay);
//             plan = each feature's own access; off = no AI for patients
//             and providers (staff and the content tools keep working)
//   per feature:
//     access  free | plan (only a plan module, a plan that includes it, or
//             patient Pro opens it) | off
//     modules the plan modules that unlock it, per provider kind
//     pro     an active patient Pro membership unlocks it
//     limits  free tier and paid tier: per user per day, per user per
//             Jalali month, per organisation per month (0 = unlimited);
//             a plan may set its own (aiQuotas on the plan)
import { z } from "zod";
import AiPolicy, { AiPolicyMode, IAiPolicy } from "../../Models/AiPolicy";
import { doctorDashboardModules } from "../../Models/BaseDoctorLicense";
import { clinicDashboardModules } from "../../Models/BaseClinicLicense";
import { hospitalDashboardModules } from "../../Models/BaseHospitalLicense";
import { pharmacyDashboardModules } from "../../Models/BasePharmacyLicense";
import { paraClinicDashboardModules } from "../../Models/BaseParaClinicLicense";
import { insuranceDashboardModules } from "../../Models/BaseInsuranceLicense";
import type { LicenseKind } from "../licenseQuote";
import {
  AI_FEATURES,
  AiAccess,
  aiAccessModes,
  AiFeatureDef,
  AiLimitSet,
  aiFeature,
  isInternal,
  isProviderAudience,
} from "./aiFeatures";

export type AiTier = "free" | "paid";

export type AiFeaturePolicy = {
  access: AiAccess;
  modules: Partial<Record<LicenseKind, string[]>>;
  pro: boolean;
  limits: Record<AiTier, AiLimitSet>;
};

export type AiPolicyView = {
  enabled: boolean;
  mode: AiPolicyMode;
  features: Record<string, AiFeaturePolicy>;
  legacy: Legacy;
  updatedAt?: Date;
};

type Legacy = { panel: number; patientFree: number; patientPro: number };
export const LEGACY_DEFAULTS: Legacy = { panel: 200, patientFree: 20, patientPro: 0 };

// the plan modules of each provider kind (what a feature can be unlocked by)
export const planModules: Record<LicenseKind, readonly string[]> = {
  doctor: doctorDashboardModules,
  clinic: clinicDashboardModules,
  hospital: hospitalDashboardModules,
  pharmacy: pharmacyDashboardModules,
  paraClinic: paraClinicDashboardModules,
  insurance: insuranceDashboardModules,
};

const whole = (v: unknown, fallback = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000_000) : fallback;
};

const limitSet = (day: number): AiLimitSet => ({ day, month: 0, orgMonth: 0 });

// the registry's default for one feature, with the old settings' numbers
export const defaultFeaturePolicy = (f: AiFeatureDef, legacy: Legacy): AiFeaturePolicy => {
  const num = (v: number | "legacy" | "patientFree" | "patientPro") =>
    v === "legacy" ? legacy.panel : v === "patientFree" ? legacy.patientFree : v === "patientPro" ? legacy.patientPro : v;
  return {
    access: f.defaults.access,
    modules: Object.fromEntries(Object.entries(f.defaults.modules).map(([k, v]) => [k, [...(v || [])]])),
    pro: f.defaults.pro,
    limits: { free: limitSet(num(f.defaults.day.free)), paid: limitSet(num(f.defaults.day.paid)) },
  };
};

// a stored entry over the default; anything malformed falls back
const mergeFeature = (f: AiFeatureDef, stored: unknown, legacy: Legacy): AiFeaturePolicy => {
  const base = defaultFeaturePolicy(f, legacy);
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<AiFeaturePolicy>;
  const access = aiAccessModes.includes(s.access as AiAccess) ? (s.access as AiAccess) : base.access;
  const modules: AiFeaturePolicy["modules"] = { ...base.modules };
  if (s.modules && typeof s.modules === "object")
    for (const [kind, list] of Object.entries(s.modules)) {
      if (!isProviderAudience(kind) || !Array.isArray(list)) continue;
      modules[kind] = list.filter((m) => typeof m === "string" && planModules[kind].includes(m));
    }
  const lim = (tier: AiTier): AiLimitSet => {
    const v = (s.limits as Record<string, Partial<AiLimitSet>> | undefined)?.[tier];
    const b = base.limits[tier];
    return v && typeof v === "object"
      ? { day: whole(v.day, b.day), month: whole(v.month, b.month), orgMonth: whole(v.orgMonth, b.orgMonth) }
      : b;
  };
  return {
    // the internal tools have no plans
    access: isInternal(f) && access === "plan" ? "free" : access,
    modules,
    pro: typeof s.pro === "boolean" ? s.pro : base.pro,
    limits: { free: lim("free"), paid: lim("paid") },
  };
};

const view = (doc: Partial<IAiPolicy> | null): AiPolicyView => {
  const legacy: Legacy = {
    panel: whole(doc?.legacy?.panel, LEGACY_DEFAULTS.panel),
    patientFree: whole(doc?.legacy?.patientFree, LEGACY_DEFAULTS.patientFree),
    patientPro: whole(doc?.legacy?.patientPro, LEGACY_DEFAULTS.patientPro),
  };
  const stored = (doc?.features && typeof doc.features === "object" ? doc.features : {}) as Record<string, unknown>;
  return {
    enabled: doc?.enabled !== false,
    mode: doc?.mode === "free" || doc?.mode === "off" ? doc.mode : "plan",
    features: Object.fromEntries(AI_FEATURES.map((f) => [f.key, mergeFeature(f, stored[f.key], legacy)])),
    legacy,
    updatedAt: doc?.updatedAt,
  };
};

let cache: { at: number; policy: AiPolicyView } | null = null;
export const clearAiPolicyCache = () => {
  cache = null;
};

// The policy now (10 s cache). Before the migration made the document,
// the registry defaults with the old settings' numbers apply.
export const getAiPolicy = async (fresh = false): Promise<AiPolicyView> => {
  if (!fresh && cache && Date.now() - cache.at < 10_000) return cache.policy;
  const doc = await AiPolicy.findOne({ singleton: "SINGLETON" }).lean<IAiPolicy>();
  const policy = view(doc || (await legacySnapshot().then((legacy) => ({ legacy }))));
  cache = { at: Date.now(), policy };
  return policy;
};

export const featurePolicy = async (key: string) => {
  const p = await getAiPolicy();
  return p.features[key];
};

// the numbers of the settings the policy replaces
export const legacySnapshot = async (): Promise<Legacy> => {
  const [{ getAppConfig }, { default: PatientProPlan }] = await Promise.all([
    import("../appConfig"),
    import("../../Models/PatientProPlan"),
  ]);
  const [config, pro] = await Promise.all([
    getAppConfig().catch(() => null),
    PatientProPlan.findOne({}).sort({ order: 1, _id: 1 }).select("freeAiDailyLimit proAiDailyLimit aiEnabled").lean<{
      freeAiDailyLimit?: number;
      proAiDailyLimit?: number;
    }>(),
  ]);
  const panel = Number((config as { panelAiDailyLimit?: number } | null)?.panelAiDailyLimit);
  return {
    panel: Number.isFinite(panel) && panel >= 0 ? Math.round(panel) : LEGACY_DEFAULTS.panel,
    patientFree: pro ? whole(pro.freeAiDailyLimit, LEGACY_DEFAULTS.patientFree) : LEGACY_DEFAULTS.patientFree,
    patientPro: pro ? whole(pro.proAiDailyLimit, LEGACY_DEFAULTS.patientPro) : LEGACY_DEFAULTS.patientPro,
  };
};

// ---------------------------------------------------------------- saving

const count = z.coerce.number().int().min(0).max(10_000_000);
const limitSchema = z.object({ day: count, month: count, orgMonth: count }).partial();
const featureSchema = z
  .object({
    access: z.enum(aiAccessModes),
    modules: z.record(z.string(), z.array(z.string().max(60)).max(60)),
    pro: z.boolean(),
    limits: z.object({ free: limitSchema, paid: limitSchema }).partial(),
  })
  .partial();
export const aiPolicySchema = z.strictObject({
  enabled: z.boolean().optional(),
  mode: z.enum(["free", "plan", "off"]).optional(),
  features: z.record(z.string(), featureSchema).optional(),
});
export type AiPolicyInput = z.infer<typeof aiPolicySchema>;

// Saves the admin's edit (any subset) over the current policy; unknown
// features and modules are dropped. Returns the new policy.
export const saveAiPolicy = async (input: AiPolicyInput, by?: unknown): Promise<AiPolicyView> => {
  const current = await getAiPolicy(true);
  const features: Record<string, AiFeaturePolicy> = { ...current.features };
  for (const [key, patch] of Object.entries(input.features || {})) {
    const f = aiFeature(key);
    if (!f) continue;
    const cur = features[key];
    features[key] = mergeFeature(
      f,
      {
        access: patch.access ?? cur.access,
        modules: patch.modules ? { ...cur.modules, ...patch.modules } : cur.modules,
        pro: patch.pro ?? cur.pro,
        limits: {
          free: { ...cur.limits.free, ...(patch.limits?.free || {}) },
          paid: { ...cur.limits.paid, ...(patch.limits?.paid || {}) },
        },
      },
      current.legacy,
    );
  }
  await AiPolicy.updateOne(
    { singleton: "SINGLETON" },
    {
      $set: {
        enabled: input.enabled ?? current.enabled,
        mode: input.mode ?? current.mode,
        features,
        legacy: current.legacy,
        ...(by ? { updatedBy: by } : {}),
      },
    },
    { upsert: true },
  );
  clearAiPolicyCache();
  return getAiPolicy(true);
};
