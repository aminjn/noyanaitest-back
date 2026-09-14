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

// Not read here - Models/SmsPatterns.ts reads process.env.OTP_PATTERN
// directly (see its smsPatternNames) to default the DB-backed SmsPatterns
// singleton's OTP_PATTERN field the first time the app runs against a
// fresh database. After that first insert, edit the pattern code from the
// admin panel instead.

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

export const GET_MEDICAL_SYSTEM_CODE_API_KEY =
  process.env.GET_MEDICAL_SYSTEM_CODE_API_KEY || "";

export const podiumUrl = "https://api.pod.ir/srv/sc2/consumers/services/do";

export const podiumUrl2 = "https://api.pod.ir/srv/sc/nzh/doServiceCall";

export const PODIUM_TOKEN = process.env.PODIUM_TOKEN || "";

export const GET_MC_CERTIFICATE_API_KEY =
  process.env.GET_MC_CERTIFICATE_API_KEY || "";

export const announcedAddress = process.env.ANNOUNCED_ADDRESS;

const defaultBookingHorizonDays = 30;

export const BOOKING_HORIZON_DAYS =
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

// How many minutes after a reservation's start time (while it's "active",
// i.e. in progress) an absent party gets nudged by SMS to join, if they
// still haven't been marked present by then. Independent of the
// finalization sweep, which only runs once the reservation's *end* time has
// passed.
const DEFAULT_RESERVATION_NO_SHOW_NUDGE_MINUTES_AFTER_START = 5;
export const RESERVATION_NO_SHOW_NUDGE_MINUTES_AFTER_START_FALLBACK =
  Number(process.env.RESERVATION_NO_SHOW_NUDGE_MINUTES_AFTER_START) ||
  DEFAULT_RESERVATION_NO_SHOW_NUDGE_MINUTES_AFTER_START;

// How often (in ms) the background job sweeps active reservations to send
// that mid-session nudge.
const DEFAULT_RESERVATION_NO_SHOW_NUDGE_INTERVAL = 30 * 1000;
export const RESERVATION_NO_SHOW_NUDGE_INTERVAL_FALLBACK =
  Number(process.env.RESERVATION_NO_SHOW_NUDGE_INTERVAL) ||
  DEFAULT_RESERVATION_NO_SHOW_NUDGE_INTERVAL;

// Hard cap on participants per call room (host + guests combined).
const DEFAULT_CALL_MAX_PARTICIPANTS = 8;
export const CALL_MAX_PARTICIPANTS_FALLBACK =
  Number(process.env.CALL_MAX_PARTICIPANTS) || DEFAULT_CALL_MAX_PARTICIPANTS;

// ---- Web push (Services/pushNotificationService.ts) ----
// VAPID keypair identifying this server to push services (Chrome/Firefox
// push endpoints, etc). Generate a pair with
// `node -e "console.log(require('web-push').generateVAPIDKeys())"` and set
// both here - VAPID_PUBLIC_KEY is also handed to the client as-is
// (GET /user/push/publicKey) so it can call pushManager.subscribe(). Unlike
// JWT_SECRET this doesn't throw at boot when missing - push is treated as
// optional infrastructure, and pushNotificationService just logs a warning
// once and no-ops instead of crashing the whole app.
export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";

export const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

// Contact URI push services may use to reach us about a misbehaving
// endpoint (mailto: or https:), required by the Web Push protocol.
export const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:admin@noyanai.com";

// ---- Snapp corporate API (Lib/snappClient.ts) ----
// B2B ride-hailing integration (2026-09), used to dispatch a Snapp Box
// courier ride for a pharmacy's order delivery
// (pharmacyController.dispatchOrderDelivery). Credentials are for our own
// corporate/manager account on Snapp's side - the resulting access/refresh
// token pair is cached in the DB (Models/SnappCredential.ts singleton), not
// here, since it's obtained at runtime via login rather than configured.
export const SNAPP_BASE_URL = process.env.SNAPP_BASE_URL || "";

export const SNAPP_USERNAME = process.env.SNAPP_USERNAME || "";

export const SNAPP_PASSWORD = process.env.SNAPP_PASSWORD || "";

// ---- Tapsi corporate API (Lib/tapsiClient.ts) ----
// B2B ride-booking integration (2026-09) - Tapsi's Corporate API
// (https://co.tapsi.ir/docs). Built as a general-purpose client wrapper,
// not wired to any specific feature yet (mirrors the Snapp block above).
// Credentials are for our own corporate account on Tapsi's side - the
// resulting JWT (valid 1 hour, no documented refresh-token endpoint) is
// cached in the DB (Models/TapsiCredential.ts singleton), not here, since
// it's obtained at runtime via login rather than configured.
export const TAPSI_BASE_URL = process.env.TAPSI_BASE_URL || "";

export const TAPSI_USERNAME = process.env.TAPSI_USERNAME || "";

export const TAPSI_PASSWORD = process.env.TAPSI_PASSWORD || "";

// ---- SMS gateway (Lib/sendSms.ts) ----
// IPPanel pattern-based SMS gateway credentials. Optional in development -
// sendSmsRaw only logs to the console (never hits the network) when
// NODE_ENV is "development" or when SMS_API_TOKEN is unset, so these only
// need to be configured for production.
export const SMS_API_TOKEN = process.env.SMS_API_TOKEN || "";

// Base send endpoint. Falls back to sendSmsRaw's DEFAULT_SMS_URL
// (IPPanel's pattern-send REST endpoint) when unset.
export const SMS_REQUEST_URL = process.env.SMS_REQUEST_URL || "";

export const SMS_FROM_NUMBER = process.env.SMS_FROM_NUMBER || "";
