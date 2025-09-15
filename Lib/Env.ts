import dotenv from "dotenv";
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
