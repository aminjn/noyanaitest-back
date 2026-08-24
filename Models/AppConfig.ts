import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

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
});

const AppConfig = mongoose.model("AppConfig", AppConfigSchema);

export default AppConfig;
