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

const sipHost = process.env.SIP_HOST;
if (!sipHost) throw new Error("Please Set SIP_HOST in env");

export const SIP_HOST = sipHost;

const sipUsername = process.env.SIP_USERNAME;
if (!sipUsername) throw new Error("Please Set SIP_USERNAME in env");
export const SIP_USERNAME = sipUsername;

const sipPass = process.env.SIP_PASSWORD;
if (!sipPass) throw new Error("Please Set SIP_PASS in env");
export const SIP_PASSWORD = sipPass;

const getIdentityInfoApiKey = process.env.GET_IDENTITY_INFO_API_KEY;
if (!getIdentityInfoApiKey)
  throw new Error("Please Set GET_IDENTITY_INFO_API_KEY in env");
export const GET_IDENTITY_INFO_API_KEY = getIdentityInfoApiKey;

const matchNationalIdAndPhoneNumberApiKey =
  process.env.MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY;

if (!matchNationalIdAndPhoneNumberApiKey)
  throw new Error(
    "Please Set MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY in env",
  );
export const MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY =
  matchNationalIdAndPhoneNumberApiKey;

const getMedicalSystemCodeApiKey = process.env.GET_MEDICAL_SYSTEM_CODE_API_KEY;
if (!getMedicalSystemCodeApiKey)
  throw new Error("Please Set GET_MEDICAL_SYSTEM_CODE_API_KEY in env");
export const GET_MEDICAL_SYSTEM_CODE_API_KEY = getMedicalSystemCodeApiKey;

export const podiumUrl = "https://api.pod.ir/srv/sc2/consumers/services/do";

export const podiumUrl2 = "https://api.pod.ir/srv/sc/nzh/doServiceCall";

const podiumToken = process.env.PODIUM_TOKEN;
if (!podiumToken) throw new Error("Please Set PODIUM_TOKEN in env");
export const PODIUM_TOKEN = podiumToken;

const getMcCertificateApiKey = process.env.GET_MC_CERTIFICATE_API_KEY;
if (!getMcCertificateApiKey)
  throw new Error("Please Set 'GET_MC_CERTIFICATE_API_KEY' in env");

export const GET_MC_CERTIFICATE_API_KEY = getMcCertificateApiKey;

export const announcedAddress = process.env.ANNOUNCED_ADDRESS;

const defaultBookingHorizonDays = 30;

export const BOOKING_HORIZON_DAYS =
  Number(process.env.BOOKING_HORIZON_DAYS) || defaultBookingHorizonDays;

const defaultRecalculateDoctorAvailabilityInterval = 24 * 60 * 60 * 1000;

export const RECALCULATE_DOCTOR_AVAILABILITY_INTERVAL =
  Number(process.env.RECALCULATE_DOCTOR_AVAILABILITY_INTERVAL) ||
  defaultRecalculateDoctorAvailabilityInterval;

// How long (in seconds) a repeated visit to the same page by the same
// visitor is deduplicated into a single PageVisit record.
const DEFAULT_ANALYTICS_VISIT_WINDOW_SECONDS = 60 as const;

export const ANALYTICS_VISIT_WINDOW_SECONDS =
  Number(process.env.ANALYTICS_VISIT_WINDOW_SECONDS) ||
  DEFAULT_ANALYTICS_VISIT_WINDOW_SECONDS;

// How long (in days) the anonymous visitor-id cookie persists for.
const DEFAULT_ANALYTICS_VISITOR_COOKIE_DAYS = 730 as const;

export const ANALYTICS_VISITOR_COOKIE_DAYS =
  Number(process.env.ANALYTICS_VISITOR_COOKIE_DAYS) ||
  DEFAULT_ANALYTICS_VISITOR_COOKIE_DAYS;

// How often (in ms) the background job scans for documents that are
// missing a slug and generates one for them.
const DEFAULT_SLUG_GENERATION_INTERVAL = 60 * 1000;

export const SLUG_GENERATION_INTERVAL =
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
export const CALL_RING_TIMEOUT_MS =
  Number(process.env.CALL_RING_TIMEOUT_MS) || DEFAULT_CALL_RING_TIMEOUT_MS;

// Hard cap on participants per call room (host + guests combined).
const DEFAULT_CALL_MAX_PARTICIPANTS = 8;
export const CALL_MAX_PARTICIPANTS =
  Number(process.env.CALL_MAX_PARTICIPANTS) || DEFAULT_CALL_MAX_PARTICIPANTS;
