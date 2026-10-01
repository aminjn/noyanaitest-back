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
  sepAmountMultiplier: number;
  // How long a SEP token stays payable (SEP clamps to 20..3600, default 20).
  sepTokenExpiryMinutes: number;
  // Smallest wallet top-up accepted, in app units (Toman).
  onlinePaymentMinAmount: number;
  // smallest wallet -> bank withdrawal (toman); was hardcoded 10,000
  withdrawalMinAmount: number;
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

  bookingHorizonDays: { type: Number, default: 30 },
  recalculateDoctorAvailabilityInterval: {
    type: Number,
    default: 24 * 60 * 60 * 1000,
  },

  analyticsVisitWindowSeconds: { type: Number, default: 60 },
  analyticsVisitorCookieDays: { type: Number, default: 730 },

  slugGenerationInterval: { type: Number, default: 60 * 1000 },

  callRingTimeoutMs: { type: Number, default: 45 * 1000 },
  callMaxParticipants: { type: Number, default: 8 },

  reservationActivationInterval: { type: Number, default: 30 * 1000 },
  reservationReminderMinutesBefore: { type: Number, default: 5 },
  reservationReminderInterval: { type: Number, default: 30 * 1000 },
  reservationFinalizationInterval: { type: Number, default: 30 * 1000 },
  reservationNoShowNudgeMinutesAfterStart: { type: Number, default: 5 },
  reservationNoShowNudgeInterval: { type: Number, default: 30 * 1000 },

  sepEnabled: { type: Boolean, default: false },
  sepTerminalId: { type: String, default: "" },
  sepCallbackBaseUrl: { type: String, default: "" },
  siteBaseUrl: { type: String, default: "" },
  sepAmountMultiplier: { type: Number, default: 10, min: 1 },
  sepTokenExpiryMinutes: { type: Number, default: 20, min: 20, max: 3600 },
  onlinePaymentMinAmount: { type: Number, default: 1000, min: 1 },
  withdrawalMinAmount: { type: Number, default: 10_000, min: 1 },
  enabledLocales: {
    type: [{ type: String, enum: locales }],
    default: () => [...locales],
  },
  defaultLocale: { type: String, enum: locales },

  nexamapEnabled: { type: Boolean, default: false },
  nexamapBaseUrl: { type: String, default: "https://api.nexamap.ir" },
  nexamapApiKey: { type: String, default: "" },
  nexamapDefaultStyle: { type: String, default: "day" },
  nexamapDarkStyle: { type: String, default: "night" },
});

// The NexaMap key never leaves the server in full, not even to the super
// admin (GET /auto/appConfig): a masked preview is sent, and
// Routers/autoRouter.ts drops it if it comes back unchanged. Application
// code reads the document's property, which this doesn't touch.
AppConfigSchema.set("toJSON", {
  transform(_doc, ret) {
    if (ret.nexamapApiKey) ret.nexamapApiKey = maskSecret(ret.nexamapApiKey);
    return ret;
  },
});

const AppConfig = mongoose.model("AppConfig", AppConfigSchema);

export default AppConfig;
