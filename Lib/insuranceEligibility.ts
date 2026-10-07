import mongoose, { isValidObjectId } from "mongoose";
import UserIdentity from "../Models/UserIdentity";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import AdminTaminCred from "../Models/AdminTaminCred";
import makeTaminRequest from "./MakeTamjinRequest";
import { getAppConfig } from "./appConfig";
import { TAMIN_END_USER_LOCKOUT } from "../Controllers/featureGateController";
import { insurerKindOf } from "./insuranceTariffs";

// Live insurance eligibility (2026-10, «استعلام برخط بیمه»;
// docs/booking-benchmark.md). Zocdoc and Doctolib check the card against
// the insurer while booking (Doctolib reads the Carte Vitale through
// ADRi); in Iran Tamin's e-prescription API has the same «استحقاق درمان»
// inquiry and Salamat has its own web service. One interface,
// checkEligibility(insurer, patient), and one provider per insurer:
//
//   tamin    built on the existing Tamin integration (the doctor's Tamin
//            token, the same deserve-info call as doctorController
//            inquiryPatientPrivilege). Under the end-user lockout
//            (Controllers/featureGateController.ts) it answers "locked"
//            for every real user; the super admin's test console uses the
//            admin sandbox credential (AdminTaminCred) instead.
//   salamat  a stub until the web service is contracted: "notConfigured".
//
// Each provider is off until the super admin turns it on (AppConfig
// insuranceEligibilityTamin / -Salamat). An answer is "verified" (the card
// is valid, with the insurer's coverage when it gives one) or
// "notEligible"; anything else ("off", "locked", "notConfigured",
// "noToken", "error", "notApplicable") means no answer: the booking keeps
// Noyan's tariff estimate (Lib/insuranceTariffs.ts).

export const eligibilityProviderIds = ["tamin", "salamat"] as const;
export type EligibilityProviderId = (typeof eligibilityProviderIds)[number];

export type EligibilityStatus =
  | "verified"
  | "notEligible"
  | "off"
  | "locked"
  | "notConfigured"
  | "noToken"
  | "notApplicable"
  | "error";

export type EligibilityResult = {
  provider: EligibilityProviderId | "none";
  status: EligibilityStatus;
  // the insurer's own share when it returns one: a percent of the visit or
  // an amount (toman)
  coverage?: { percent?: number; amount?: number };
  // a short Persian line for the admin console / logs
  message?: string;
};

export type EligibilityInsurer = { _id?: unknown; name?: string; isBasic?: boolean };
export type EligibilityPatient = { identity?: unknown; nationalId?: string };
export type EligibilityContext = {
  // the booking's doctor (whose Tamin connection is used)
  doctorId?: unknown;
  // the super admin's test console: the sandbox credential, past the lockout
  admin?: boolean;
  // ignore the on/off setting (the console tests a provider before turning it on)
  force?: boolean;
};

export interface EligibilityProvider {
  id: EligibilityProviderId;
  // does this provider answer for that insurer
  matches: (insurer: EligibilityInsurer) => boolean;
  check: (insurer: EligibilityInsurer, nationalId: string, ctx: EligibilityContext) => Promise<EligibilityResult>;
}

// ---------------------------------------------------------------- Tamin

const TAMIN_DESERVE = (nationalId: string) =>
  // the sandbox identifiers every Tamin call of the integration uses
  // (doctorController inquiryPatientPrivilege, adminTaminController)
  `https://ep-test.tamin.ir/api/v2/patients/deserve-info/1234567891/2000200092/2000200092/${nationalId}`;

const numberIn = (o: Record<string, unknown> | undefined, keys: string[]) => {
  for (const k of keys) {
    const v = Number(o?.[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
};

const taminProvider: EligibilityProvider = {
  id: "tamin",
  matches: (insurer) => insurerKindOf(insurer) === "tamin",
  check: async (_insurer, nationalId, ctx) => {
    if (TAMIN_END_USER_LOCKOUT && !ctx.admin)
      return { provider: "tamin", status: "locked", message: "تأمین اجتماعی برای کاربران واقعی موقتاً غیرفعال است" };
    const cred = ctx.admin
      ? await AdminTaminCred.findOne({}).select("token").lean<{ token?: string }>()
      : ctx.doctorId && isValidObjectId(String(ctx.doctorId))
        ? await DoctorTaminCred.findOne({ doctor: ctx.doctorId }).select("token").lean<{ token?: string }>()
        : null;
    if (!cred?.token) return { provider: "tamin", status: "noToken", message: "اتصال به سامانه‌ی تأمین برقرار نیست" };
    const response = await makeTaminRequest({ path: TAMIN_DESERVE(nationalId), method: "GET", token: cred.token });
    if (!response.headers.get("Content-Type")?.includes("json"))
      return { provider: "tamin", status: "error", message: "جواب دریافتی از سامانه معتبر نبود" };
    const body = (await response.json()) as { data?: Record<string, unknown> };
    const data = body?.data;
    if (typeof data?.hasDeserve !== "boolean")
      return { provider: "tamin", status: "error", message: "جواب دریافتی از سامانه معتبر نبود" };
    if (!data.hasDeserve) return { provider: "tamin", status: "notEligible" };
    const percent = numberIn(data, ["coveragePercent", "organizationPercent", "orgPercent", "percent"]);
    const amount = numberIn(data, ["coverageAmount", "organizationShare", "orgShare"]);
    return {
      provider: "tamin",
      status: "verified",
      ...(percent || amount ? { coverage: percent ? { percent: Math.min(100, percent) } : { amount } } : {}),
    };
  },
};

// -------------------------------------------------------------- Salamat

// The Salamat insurer's eligibility web service is not contracted yet:
// the provider exists so the setting, the console and the booking already
// speak to it, and says so plainly.
const salamatProvider: EligibilityProvider = {
  id: "salamat",
  matches: (insurer) => insurerKindOf(insurer) === "salamat",
  check: async () => ({ provider: "salamat", status: "notConfigured", message: "وب‌سرویس استحقاق بیمه‌ی سلامت هنوز پیکربندی نشده است" }),
};

export const eligibilityProviders: EligibilityProvider[] = [taminProvider, salamatProvider];

export const eligibilitySettingKey: Record<EligibilityProviderId, "insuranceEligibilityTamin" | "insuranceEligibilitySalamat"> = {
  tamin: "insuranceEligibilityTamin",
  salamat: "insuranceEligibilitySalamat",
};

export const eligibilitySettings = async () => {
  const c = (await getAppConfig()) as unknown as Record<string, unknown>;
  return Object.fromEntries(eligibilityProviderIds.map((id) => [id, c[eligibilitySettingKey[id]] === true])) as Record<
    EligibilityProviderId,
    boolean
  >;
};

// ---------------------------------------------------------------- check

// answers are kept a few minutes: a booking page re-quotes on every change
const CACHE_MS = 10 * 60 * 1000;
const ERROR_CACHE_MS = 60 * 1000;
const cache = new Map<string, { at: number; result: EligibilityResult }>();

const nationalIdOf = async (p: EligibilityPatient) => {
  if (p.nationalId) return p.nationalId;
  if (!p.identity || !isValidObjectId(String(p.identity))) return "";
  const id = await UserIdentity.findById(p.identity as mongoose.Types.ObjectId).select("nationalId").lean<{ nationalId?: string }>();
  return id?.nationalId || "";
};

export const checkEligibility = async (
  insurer: EligibilityInsurer,
  patient: EligibilityPatient,
  ctx: EligibilityContext = {},
): Promise<EligibilityResult> => {
  const provider = eligibilityProviders.find((p) => p.matches(insurer));
  if (!provider) return { provider: "none", status: "notApplicable" };
  if (!ctx.force && !(await eligibilitySettings())[provider.id]) return { provider: provider.id, status: "off" };
  const nationalId = (await nationalIdOf(patient)).replace(/\D/g, "");
  if (!/^\d{10}$/.test(nationalId)) return { provider: provider.id, status: "notApplicable", message: "کد ملی بیمار ثبت نشده است" };
  const key = `${provider.id}|${ctx.admin ? "admin" : String(ctx.doctorId || "")}|${nationalId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (["verified", "notEligible"].includes(hit.result.status) ? CACHE_MS : ERROR_CACHE_MS))
    return hit.result;
  let result: EligibilityResult;
  try {
    result = await provider.check(insurer, nationalId, ctx);
  } catch (err) {
    console.log(`[eligibility] ${provider.id} failed:`, err);
    result = { provider: provider.id, status: "error", message: "ارتباط با سامانه‌ی بیمه برقرار نشد" };
  }
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return result;
};
