import dotenv from "dotenv";
import os from "os";
dotenv.config({ path: "./.env" });

const DEFAULT_PORT = 5000 as const;
export const port = Number(process.env.PORT) || DEFAULT_PORT;

const DEFAULT_DB_PORT = 27017 as const;
export const dbPort = Number(process.env.DB_PORT) || DEFAULT_DB_PORT;

const DEFAULT_DB_NAME = "NoyanAi" as const;
export const dbName = process.env.DB_NAME || DEFAULT_DB_NAME;

const DEFAULT_DB_HOST = `127.0.0.1` as const;
export const dbHost = process.env.DB_HOST || DEFAULT_DB_HOST;

export const DB_USERNAME = process.env.DB_USERNAME;

export const DB_PASSWORD = process.env.DB_PASSWORD;

export const JWT_EXPIRES_IN = Number(process.env.JWT_EXPIRES_IN) || 1;

const nodeEnvs = ["production", "development"] as const;

export const NODE_ENV =
  nodeEnvs.find((el) => el === process.env.NODE_ENV) || "development";

const _JWT_SeCRET = process.env.JWT_SECRET;

if (!_JWT_SeCRET) throw new Error("Please Set JWT_SECRET in env");

export const JWT_SECRET = _JWT_SeCRET;

export const OTP_PATTERN = process.env.OTP_PATTERN;

const DEFAULT_OTP_TTL = 120 as const;

export const OTP_TTL = Number(process.env.OTP_TTL) || DEFAULT_OTP_TTL;

const DEFAULT_BASE_OTP_INTERVAL = 30 as const;
export const BASE_OTP_INTERVAL =
  Number(process.env.BASE_OTP_INTERVAL) || DEFAULT_BASE_OTP_INTERVAL;

const DEFAULT_OTP_MAX_TRYS = 10 as const;

export const OTP_MAX_TRYS =
  Number(process.env.OTP_MAX_TRYS) || DEFAULT_OTP_MAX_TRYS;

// ---- Fallback/seed defaults only ----
// The block below used to be the live source for these settings (each one
// required in .env, several throwing at boot if missing). They now live in
// the DB-backed AppConfig singleton instead (Models/AppConfig.ts), editable
// from the admin panel, via Lib/appConfig.ts's getAppConfig(). These
// `_FALLBACK` exports are only read once, by getAppConfig(), to seed that
// singleton the first time it's created - so an existing deployment's .env
// values carry over instead of getting silently blanked. Nothing else
// should import these directly; use getAppConfig() instead.

export const SIP_HOST_FALLBACK = process.env.SIP_HOST || "";
export const SIP_USERNAME_FALLBACK = process.env.SIP_USERNAME || "";
export const SIP_PASSWORD_FALLBACK = process.env.SIP_PASSWORD || "";

export const GET_IDENTITY_INFO_API_KEY_FALLBACK =
  process.env.GET_IDENTITY_INFO_API_KEY || "";

export const MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY_FALLBACK =
  process.env.MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY || "";

export const GET_MEDICAL_SYSTEM_CODE_API_KEY_FALLBACK =
  process.env.GET_MEDICAL_SYSTEM_CODE_API_KEY || "";

export const podiumUrl = "https://api.pod.ir/srv/sc2/consumers/services/do";

export const podiumUrl2 = "https://api.pod.ir/srv/sc/nzh/doServiceCall";

export const PODIUM_TOKEN_FALLBACK = process.env.PODIUM_TOKEN || "";

export const GET_MC_CERTIFICATE_API_KEY_FALLBACK =
  process.env.GET_MC_CERTIFICATE_API_KEY || "";

export const announcedAddress = process.env.ANNOUNCED_ADDRESS;

const defaultBookingHorizonDays = 30;

export const BOOKING_HORIZON_DAYS_FALLBACK =
  Number(process.env.BOOKING_HORIZON_DAYS) || defaultBookingHorizonDays;

const defaultRecalculateDoctorAvailabilityInterval = 24 * 60 * 60 * 1000;

export const RECALCULATE_DOCTOR_AVAILABILITY_INTERVAL_FALLBACK =
  Number(process.env.RECALCULATE_DOCTOR_AVAILABILITY_INTERVAL) ||
  defaultRecalculateDoctorAvailabilityInterval;

// How long (in seconds) a repeated visit to the same page by the same
// visitor is deduplicated into a single PageVisit record.
const DEFAULT_ANALYTICS_VISIT_WINDOW_SECONDS = 60 as const;

export const ANALYTICS_VISIT_WINDOW_SECONDS_FALLBACK =
  Number(process.env.ANALYTICS_VISIT_WINDOW_SECONDS) ||
  DEFAULT_ANALYTICS_VISIT_WINDOW_SECONDS;

// How long (in days) the anonymous visitor-id cookie persists for.
const DEFAULT_ANALYTICS_VISITOR_COOKIE_DAYS = 730 as const;

export const ANALYTICS_VISITOR_COOKIE_DAYS_FALLBACK =
  Number(process.env.ANALYTICS_VISITOR_COOKIE_DAYS) ||
  DEFAULT_ANALYTICS_VISITOR_COOKIE_DAYS;

// How often (in ms) the background job scans for documents that are
// missing a slug and generates one for them.
const DEFAULT_SLUG_GENERATION_INTERVAL = 60 * 1000;

export const SLUG_GENERATION_INTERVAL_FALLBACK =
  Number(process.env.SLUG_GENERATION_INTERVAL) ||
  DEFAULT_SLUG_GENERATION_INTERVAL;

// ---- Call service (mediasoup + socket.io) ----

// UDP/TCP port range mediasoup workers listen on for WebRTC/Plain
// transports. Each worker gets an even slice of this range so ports never
// collide between workers. Make sure this range is open on the firewall.
const DEFAULT_MEDIASOUP_MIN_PORT = 40000;
export const MEDIASOUP_MIN_PORT =
  Number(process.env.MEDIASOUP_MIN_PORT) || DEFAULT_MEDIASOUP_MIN_PORT;

const DEFAULT_MEDIASOUP_MAX_PORT = 49999;
export const MEDIASOUP_MAX_PORT =
  Number(process.env.MEDIASOUP_MAX_PORT) || DEFAULT_MEDIASOUP_MAX_PORT;

// One mediasoup Worker is roughly one CPU core's worth of media routing
// capacity. Defaults to the number of logical cores on the host.
export const MEDIASOUP_NUM_WORKERS =
  Number(process.env.MEDIASOUP_NUM_WORKERS) || os.cpus().length || 1;

// Directory (relative to process.cwd(), sibling of Public/NotPublic) where
// call recordings get written. Private by default - never served statically.
export const CALL_RECORDING_DIR =
  process.env.CALL_RECORDING_DIR || "CallRecordings";

// Path/binary name used to spawn ffmpeg for recording. Must be installed on
// the host for recording to work; recording requests fail gracefully if not.
export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

// How long (in ms) an ad-hoc call stays in "ringing" status before it's
// auto-cancelled if nobody answers.
const DEFAULT_CALL_RING_TIMEOUT_MS = 45 * 1000;
export const CALL_RING_TIMEOUT_MS_FALLBACK =
  Number(process.env.CALL_RING_TIMEOUT_MS) || DEFAULT_CALL_RING_TIMEOUT_MS;

// How often (in ms) the background job sweeps pending reservations whose
// start time has arrived and dispatches the appropriate session channel
// (chat/call/sip/inPerson).
const DEFAULT_RESERVATION_ACTIVATION_INTERVAL = 30 * 1000;
export const RESERVATION_ACTIVATION_INTERVAL_FALLBACK =
  Number(process.env.RESERVATION_ACTIVATION_INTERVAL) ||
  DEFAULT_RESERVATION_ACTIVATION_INTERVAL;

// How many minutes before a reservation's start time the "upcoming in N
// minutes" reminder notification goes out to both parties.
const DEFAULT_RESERVATION_REMINDER_MINUTES_BEFORE = 5;
export const RESERVATION_REMINDER_MINUTES_BEFORE_FALLBACK =
  Number(process.env.RESERVATION_REMINDER_MINUTES_BEFORE) ||
  DEFAULT_RESERVATION_REMINDER_MINUTES_BEFORE;

// How often (in ms) the background job sweeps pending reservations to send
// that reminder.
const DEFAULT_RESERVATION_REMINDER_INTERVAL = 30 * 1000;
export const RESERVATION_REMINDER_INTERVAL_FALLBACK =
  Number(process.env.RESERVATION_REMINDER_INTERVAL) ||
  DEFAULT_RESERVATION_REMINDER_INTERVAL;

// How often (in ms) the background job sweeps activated reservations whose
// scheduled end time has passed, to decide their final outcome (completed /
// patient no-show / doctor no-show / error) and fire the matching trigger.
const DEFAULT_RESERVATION_FINALIZATION_INTERVAL = 30 * 1000;
export const RESERVATION_FINALIZATION_INTERVAL_FALLBACK =
  Number(process.env.RESERVATION_FINALIZATION_INTERVAL) ||
  DEFAULT_RESERVATION_FINALIZATION_INTERVAL;

// Hard cap on participants per call room (host + guests combined).
const DEFAULT_CALL_MAX_PARTICIPANTS = 8;
export const CALL_MAX_PARTICIPANTS_FALLBACK =
  Number(process.env.CALL_MAX_PARTICIPANTS) || DEFAULT_CALL_MAX_PARTICIPANTS;
