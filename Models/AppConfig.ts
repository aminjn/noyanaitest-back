import { Locale, locales } from "../Lib/locales";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { maskSecret } from "../Lib/secretMask";

// Singleton document holding runtime configuration that used to live only
// in .env - admins can now view/edit these from the admin panel
// (Routers/autoRouter.ts registers this model with `singleton: true`,
// exposing GET/POST /auto/appConfig). Application code should never import
// this model directly - go through Lib/appConfig.ts's getAppConfig(),
// which also seeds these fields from .env the first time the app runs
// against a fresh database (see ENV_SEED_DEFAULTS there).
export interface IAppConfig extends MongoDoc {
  singleton: "SINGLETON";

  // --- SIP / Asterisk ARI (Lib/sipService.ts, Controllers/adminController.ts testSip) ---
  sipHost: string;
  sipUsername: string;
  sipPassword: string;

  // --- Podium (Sabt Ahval / Tamin identity services) API keys ---
  getIdentityInfoApiKey: string;
  matchNationalIdAndPhoneNumberApiKey: string;
  getMedicalSystemCodeApiKey: string;
  podiumToken: string;
  getMcCertificateApiKey: string;

  // --- Booking / doctor availability ---
  bookingHorizonDays: number;
  recalculateDoctorAvailabilityInterval: number;

  // --- Analytics ---
  analyticsVisitWindowSeconds: number;
  analyticsVisitorCookieDays: number;

  // --- Background jobs ---
  slugGenerationInterval: number;

  // --- Calls ---
  callRingTimeoutMs: number;
  callMaxParticipants: number;

  // --- Reservation lifecycle sweeps ---
  reservationActivationInterval: number;
  reservationReminderMinutesBefore: number;
  reservationReminderInterval: number;
  reservationFinalizationInterval: number;
  reservationNoShowNudgeMinutesAfterStart: number;
  reservationNoShowNudgeInterval: number;
  // How many hours before the start a patient may still cancel online with
  // a full refund (Services/reservationCancelService.ts). Was a fixed 24.
  patientFreeCancelHours: number;
  // the live insurance eligibility check (2026-10,
  // Lib/insuranceEligibility.ts), per provider; off by default
  insuranceEligibilityTamin?: boolean;
  insuranceEligibilitySalamat?: boolean;
  // The extra appointment reminders (in-app + SMS to the patient), 24 hours
  // and 2 hours before the visit - Services/reservationActivationService.ts
  // runReservationStageReminderSweep. Each one can be switched off.
  reservationReminder24hEnabled: boolean;
  reservationReminder2hEnabled: boolean;

  // --- Public health pages (disease / symptom / drug): the "in an
  // emergency call ..." note. The wording is a UI text per language; these
  // only carry the number and whether the note shows (GET /public/locales).
  emergencyNumber: string;
  emergencyNoteEnabled: boolean;

  // --- SEP (Saman Electronic Payment) online gateway (Lib/sepClient.ts,
  // Services/paymentService.ts) - wallet top-up + cart "sep" method ---
  // Master switch: while false, every SEP entry point refuses and the
  // frontend hides the online-payment options (GET /payment/config).
  sepEnabled: boolean;
  // Merchant terminal id issued by SEP (sent as TerminalId / TerminalNumber).
  sepTerminalId: string;
  // Public origin of THIS backend as the shopper's browser reaches it (e.g.
  // https://api.example.com, no trailing slash) - SEP redirects the browser
  // to `${sepCallbackBaseUrl}/api/v1/payment/sep/callback` after payment.
  sepCallbackBaseUrl: string;
  // Public origin of the frontend site (e.g. https://example.com) - the
  // callback sends the browser on to `${siteBaseUrl}/payment/<id>`.
  siteBaseUrl: string;
  // Wallet balances and prices are stored in Toman, SEP's Amount is Rial -
  // gateway amount = app amount * this (10 unless the app moves to Rial).
  // How long a SEP token stays payable (SEP clamps to 20..3600, default 20).
  sepTokenExpiryMinutes: number;
  // Smallest wallet top-up accepted, in app units (Toman).
  onlinePaymentMinAmount: number;
  // smallest wallet -> bank withdrawal (toman); was hardcoded 10,000
  withdrawalMinAmount: number;
  // --- Seller response deadlines of cart orders (2026-10 owner decision,
  // Lib/orderResponse.ts): a pharmacy / lab line nobody answered (accept,
  // prescription review, lab result, shipment, fulfil) within these hours
  // of payment is cancelled automatically and the buyer refunded. The
  // seller is warned `orderResponseWarnHours` before (0 = no warning).
  orderResponseHoursPharmacy: number;
  orderResponseHoursLab: number;
  orderResponseWarnHours: number;
  // how many times one lab sampling appointment may be moved by the buyer
  // or the lab (2026-10, Lib/labSampling.ts rescheduleSampling); support is
  // not limited. 0 = no rescheduling. The buyer accepting the lab's
  // proposal is not counted (moves[].by "labProposal").
  labSamplingMaxMoves: number;
  // how many in-lab <-> home proposals a lab may make on one appointment
  // (2026-10, Lib/labSamplingProposal.ts). Each sends the buyer an SMS, so
  // it is capped; an accepted one does not count against
  // labSamplingMaxMoves. 0 = labs make no proposals.
  labSamplingMaxLabProposals: number;
  // Languages the site serves (2026-09) - super admin "Site languages".
  // The default language is always on; a disabled language's URLs redirect
  // to the default one.
  enabledLocales: Locale[];
  // the site's default language (unprefixed URLs, the super admin panel);
  // Persian until the super admin picks another (Lib/siteLocales.ts)
  defaultLocale?: Locale;

  // --- NexaMap (Lib/nexamap.ts): every map, address search, route and
  // place lookup of the site. The key stays on the server: browsers reach
  // NexaMap only through /api/v1/map (tiles and style included) ---
  nexamapEnabled: boolean;
  nexamapBaseUrl: string;
  nexamapApiKey: string;
  // MapLibre style names served by /v1/style.json for light and dark theme
  nexamapDefaultStyle: string;
  nexamapDarkStyle: string;
  // "Open in navigation" on NexaMap's own site/app: a link template with
  // {lat} {lng} {name}; empty = our route page (app/map/route)
  nexamapNavUrl: string;

  // --- AI (Lib/aiSettings.ts). Empty = the old .env variable; an unset
  // switch follows whether .env had the feature configured ---
  aiProvider?: "" | "anthropic" | "openai" | "ollama";
  aiApiKey?: string;
  aiBaseUrl?: string;
  ollamaHost?: string;
  translationAiEnabled?: boolean;
  translationAiModel?: string;
  clinicalAiEnabled?: boolean;
  clinicalAiProvider?: "" | "ollama" | "cloud";
  clinicalAiModel?: string;
  sttEnabled?: boolean;
  sttUrl?: string;
  sttApiKey?: string;
  sttModel?: string;
  sttLanguage?: string;
  // AI in the provider panels (2026-10): the old single per-user daily cap.
  // Since the AI policy (Lib/ai/aiPolicy.ts) only the number the per-feature
  // limits started from (Lib/migrateAiPolicy.ts); no longer enforced
  panelAiDailyLimit?: number;
}

const AppConfigSchema = new mongoose.Schema<IAppConfig, Model<IAppConfig>>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },

  sipHost: { type: String, default: "" },
  sipUsername: { type: String, default: "" },
  sipPassword: { type: String, default: "" },

  getIdentityInfoApiKey: { type: String, default: "" },
  matchNationalIdAndPhoneNumberApiKey: { type: String, default: "" },
  getMedicalSystemCodeApiKey: { type: String, default: "" },
  podiumToken: { type: String, default: "" },
  getMcCertificateApiKey: { type: String, default: "" },

  // booking settings (admin "تنظیمات نوبت‌دهی"): a 0 or negative horizon
  // would close every calendar, a huge one recalculates years of slots
  bookingHorizonDays: { type: Number, default: 30, min: 1, max: 365 },
  recalculateDoctorAvailabilityInterval: {
    type: Number,
    default: 24 * 60 * 60 * 1000,
    min: 60_000,
  },

  analyticsVisitWindowSeconds: { type: Number, default: 60 },
  analyticsVisitorCookieDays: { type: Number, default: 730 },

  slugGenerationInterval: { type: Number, default: 60 * 1000, min: 10_000 },

  callRingTimeoutMs: { type: Number, default: 45 * 1000, min: 5_000, max: 10 * 60 * 1000 },
  callMaxParticipants: { type: Number, default: 8, min: 2, max: 50 },

  reservationActivationInterval: { type: Number, default: 30 * 1000, min: 10_000 },
  reservationReminderMinutesBefore: { type: Number, default: 5, min: 0, max: 24 * 60 },
  reservationReminderInterval: { type: Number, default: 30 * 1000, min: 10_000 },
  reservationFinalizationInterval: { type: Number, default: 30 * 1000, min: 10_000 },
  reservationNoShowNudgeMinutesAfterStart: { type: Number, default: 5, min: 0, max: 240 },
  reservationNoShowNudgeInterval: { type: Number, default: 30 * 1000, min: 10_000 },
  // 0 = up to the start; at most a week
  patientFreeCancelHours: { type: Number, default: 24, min: 0, max: 168 },
  reservationReminder24hEnabled: { type: Boolean, default: true },
  // the live insurance eligibility providers (Lib/insuranceEligibility.ts)
  insuranceEligibilityTamin: { type: Boolean, default: false },
  insuranceEligibilitySalamat: { type: Boolean, default: false },
  reservationReminder2hEnabled: { type: Boolean, default: true },

  // digits (and + * #) only: it is put into a sentence and a tel: link
  emergencyNumber: {
    type: String,
    default: "115",
    trim: true,
    match: /^[0-9+*#]{2,15}$/,
  },
  emergencyNoteEnabled: { type: Boolean, default: true },

  sepEnabled: { type: Boolean, default: false },
  sepTerminalId: { type: String, default: "" },
  sepCallbackBaseUrl: { type: String, default: "" },
  siteBaseUrl: { type: String, default: "" },
  sepTokenExpiryMinutes: { type: Number, default: 20, min: 20, max: 3600 },
  onlinePaymentMinAmount: { type: Number, default: 1000, min: 1 },
  withdrawalMinAmount: { type: Number, default: 10_000, min: 1 },
  // at least an hour, at most 30 days
  orderResponseHoursPharmacy: { type: Number, default: 24, min: 1, max: 720 },
  orderResponseHoursLab: { type: Number, default: 72, min: 1, max: 720 },
  orderResponseWarnHours: { type: Number, default: 2, min: 0, max: 48 },
  labSamplingMaxMoves: { type: Number, default: 2, min: 0, max: 10 },
  labSamplingMaxLabProposals: { type: Number, default: 2, min: 0, max: 10 },
  enabledLocales: {
    type: [{ type: String, enum: locales }],
    default: () => [...locales],
  },
  defaultLocale: { type: String, enum: locales },

  nexamapEnabled: { type: Boolean, default: false },
  nexamapBaseUrl: { type: String, default: "https://nexamap.ir" },
  nexamapApiKey: { type: String, default: "" },
  nexamapDefaultStyle: { type: String, default: "day" },
  nexamapDarkStyle: { type: String, default: "night" },
  nexamapNavUrl: { type: String, default: "" },

  aiProvider: { type: String, enum: ["", "anthropic", "openai", "ollama"], default: "" },
  aiApiKey: { type: String, default: "" },
  aiBaseUrl: { type: String, default: "" },
  ollamaHost: { type: String, default: "" },
  translationAiEnabled: { type: Boolean },
  translationAiModel: { type: String, default: "" },
  clinicalAiEnabled: { type: Boolean },
  clinicalAiProvider: { type: String, enum: ["", "ollama", "cloud"], default: "" },
  clinicalAiModel: { type: String, default: "" },
  sttEnabled: { type: Boolean },
  sttUrl: { type: String, default: "" },
  sttApiKey: { type: String, default: "" },
  sttModel: { type: String, default: "" },
  sttLanguage: { type: String, default: "" },
  panelAiDailyLimit: { type: Number, default: 200, min: 0 },
});

// The keys never leave the server in full, not even to the super
// admin (GET /auto/appConfig): a masked preview is sent, and
// Routers/autoRouter.ts drops it if it comes back unchanged. Application
// code reads the document's property, which this doesn't touch.
// every key and password the same way (they used to reach the browser in
// full: the SIP password and the Podium / identity API keys)
export const APP_CONFIG_SECRETS = [
  "nexamapApiKey",
  "aiApiKey",
  "sttApiKey",
  "sipPassword",
  "podiumToken",
  "getIdentityInfoApiKey",
  "matchNationalIdAndPhoneNumberApiKey",
  "getMedicalSystemCodeApiKey",
  "getMcCertificateApiKey",
] as const;
AppConfigSchema.set("toJSON", {
  transform(_doc, ret) {
    for (const k of APP_CONFIG_SECRETS) if (ret[k]) ret[k] = maskSecret(ret[k]);
    return ret;
  },
});

const AppConfig = mongoose.model("AppConfig", AppConfigSchema);

export default AppConfig;
