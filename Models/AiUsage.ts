import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// AI use per feature (2026-10, Lib/ai/aiGate.ts checkAndConsumeAi): one row
// per subject (a user, an organisation for its monthly limit, or the
// platform for its content tools), feature
// (Lib/ai/aiFeatures.ts) and Tehran calendar day. Replaces the shared
// counters PanelAiUsage (panel AI) and AiDailyUsage (the patient's
// assistant); the finance assistant keeps its detailed log (BizAiUsage).
//   count     units used: requests, or started minutes of audio
//   requests  calls, whatever their units
//   failed    calls the model did not answer (their units were given back)
// `month` is the Jalali month ("1405-07") a monthly limit sums over.
// "platform": the content tools' own budget (one subject, Lib/ai/aiGate.ts)
export const aiUsageScopes = ["user", "org", "platform"] as const;
export type AiUsageScope = (typeof aiUsageScopes)[number];

export interface IAiUsage extends MongoDoc {
  scope: AiUsageScope;
  // the user, or the organisation (doctor profile, clinic, ...)
  subject: mongoose.Types.ObjectId;
  feature: string;
  // "YYYY-MM-DD" in Asia/Tehran
  day: string;
  // "jYYYY-jMM" in Asia/Tehran
  month: string;
  // patient, doctor, clinic, ..., staff, admin
  audience: string;
  // the paid tier (a plan or Pro unlocked it) at the time of use
  tier: "free" | "paid";
  // a user's row: the organisation they acted for (for the report)
  orgKind?: string;
  org?: mongoose.Types.ObjectId;
  count: number;
  requests: number;
  failed: number;
  createdAt: Date;
  updatedAt: Date;
}

const AiUsageSchema = new mongoose.Schema<IAiUsage, Model<IAiUsage>>(
  {
    scope: { type: String, enum: aiUsageScopes, required: true },
    subject: { type: mongoose.Schema.ObjectId, required: true },
    feature: { type: String, required: true },
    day: { type: String, required: true },
    month: { type: String, required: true },
    audience: { type: String, required: true },
    tier: { type: String, enum: ["free", "paid"], default: "free" },
    orgKind: { type: String },
    org: { type: mongoose.Schema.ObjectId },
    count: { type: Number, default: 0, min: 0 },
    requests: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

AiUsageSchema.index({ scope: 1, subject: 1, feature: 1, day: 1 }, { unique: true });
AiUsageSchema.index({ scope: 1, subject: 1, feature: 1, month: 1 });
AiUsageSchema.index({ day: 1, feature: 1 });
// the report reads a year at most
AiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

const AiUsage = mongoose.model("AiUsage", AiUsageSchema);
export default AiUsage;
