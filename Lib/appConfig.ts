import AppConfig, { IAppConfig } from "../Models/AppConfig";
import * as env from "./Env";

// The DB-backed AppConfig singleton (Models/AppConfig.ts) is the source of
// truth for the settings below - the admin panel reads/writes it via the
// generic singleton route (/auto/appConfig, see Routers/autoRouter.ts).
// These constants only matter the very first time getAppConfig() runs
// against a fresh database: they seed the singleton from whatever was
// already in .env, so upgrading an existing deployment doesn't silently
// blank out live secrets (SIP creds, Podium keys, ...). After that first
// insert, .env is never consulted again for these values - edit them from
// the admin panel instead.
const ENV_SEED_DEFAULTS = {
  sipHost: env.SIP_HOST_FALLBACK,
  sipUsername: env.SIP_USERNAME_FALLBACK,
  sipPassword: env.SIP_PASSWORD_FALLBACK,

  getIdentityInfoApiKey: env.GET_IDENTITY_INFO_API_KEY_FALLBACK,
  matchNationalIdAndPhoneNumberApiKey:
    env.MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY_FALLBACK,
  getMedicalSystemCodeApiKey: env.GET_MEDICAL_SYSTEM_CODE_API_KEY,
  podiumToken: env.PODIUM_TOKEN,
  getMcCertificateApiKey: env.GET_MC_CERTIFICATE_API_KEY,

  bookingHorizonDays: env.BOOKING_HORIZON_DAYS,
  recalculateDoctorAvailabilityInterval:
    env.RECALCULATE_DOCTOR_AVAILABILITY_INTERVAL_FALLBACK,

  analyticsVisitWindowSeconds: env.ANALYTICS_VISIT_WINDOW_SECONDS_FALLBACK,
  analyticsVisitorCookieDays: env.ANALYTICS_VISITOR_COOKIE_DAYS_FALLBACK,

  slugGenerationInterval: env.SLUG_GENERATION_INTERVAL_FALLBACK,

  callRingTimeoutMs: env.CALL_RING_TIMEOUT_MS_FALLBACK,
  callMaxParticipants: env.CALL_MAX_PARTICIPANTS_FALLBACK,

  reservationActivationInterval: env.RESERVATION_ACTIVATION_INTERVAL_FALLBACK,
  reservationReminderMinutesBefore:
    env.RESERVATION_REMINDER_MINUTES_BEFORE_FALLBACK,
  reservationReminderInterval: env.RESERVATION_REMINDER_INTERVAL_FALLBACK,
  reservationFinalizationInterval:
    env.RESERVATION_FINALIZATION_INTERVAL_FALLBACK,
  reservationNoShowNudgeMinutesAfterStart:
    env.RESERVATION_NO_SHOW_NUDGE_MINUTES_AFTER_START_FALLBACK,
  reservationNoShowNudgeInterval:
    env.RESERVATION_NO_SHOW_NUDGE_INTERVAL_FALLBACK,
};

// Fetches the single AppConfig document, creating it (seeded from .env, see
// above) if this is the first call against a fresh database. Deliberately
// re-reads from the DB every call rather than caching in memory - admins
// expect edits made from the settings page to take effect immediately, and
// this is a single indexed findOne, not a hot path. The exceptions are the
// background-job intervals (server.ts's init()), which are only read once
// at boot to configure setInterval - changing those from the admin panel
// takes effect on the next server restart, not live.
export const getAppConfig = async (): Promise<IAppConfig> => {
  const config = await AppConfig.findOneAndUpdate(
    { singleton: "SINGLETON" },
    { $setOnInsert: ENV_SEED_DEFAULTS },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return config;
};

// How many days ahead patients can book (the admin's "booking settings").
// Every availability recalculation uses it - a doctor's own shift, office
// or time-off change used the .env seed instead, so a longer horizon set by
// the admin left the later days stale until the nightly-ish cron.
export const getBookingHorizonDays = async (): Promise<number> => {
  const days = Number((await getAppConfig()).bookingHorizonDays);
  return Number.isFinite(days) && days > 0 ? days : env.BOOKING_HORIZON_DAYS;
};
