import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One row per SMS send attempt (2026-10 audit, P3-17): support answers
// "I never got the code" from here instead of the gateway's own panel.
// Written by Lib/sendSms.ts only. The message variables are never stored -
// they carry OTP codes and patient details; only the pattern and the result.
// Rows expire after 90 days (TTL index on `at`).

export const smsLogStatuses = ["sent", "failed", "skipped"] as const;
export type SmsLogStatus = (typeof smsLogStatuses)[number];

export interface ISmsLog extends MongoDoc {
  to: string;
  // Models/SmsPatterns.ts's pattern name (e.g. OTP_PATTERN), not the code
  pattern: string;
  // the gateway pattern code actually sent (empty when none was set)
  code?: string;
  locale?: string;
  status: SmsLogStatus;
  error?: string;
  // the gateway's outbox id, for tracing a delivery with the provider
  outboxId?: string;
  at: Date;
}

export const SMS_LOG_TTL_SECONDS = 90 * 24 * 60 * 60;

const SmsLogSchema = new mongoose.Schema<ISmsLog, Model<ISmsLog>>({
  to: { type: String, required: true, index: true },
  pattern: { type: String, required: true, index: true },
  code: { type: String },
  locale: { type: String },
  status: { type: String, enum: smsLogStatuses, required: true, index: true },
  error: { type: String, maxlength: 1000 },
  outboxId: { type: String },
  at: { type: Date, default: () => new Date() },
});

SmsLogSchema.index({ at: 1 }, { expireAfterSeconds: SMS_LOG_TTL_SECONDS });
SmsLogSchema.index({ pattern: 1, status: 1, at: -1 });

const SmsLog = mongoose.model("SmsLog", SmsLogSchema);

export default SmsLog;
