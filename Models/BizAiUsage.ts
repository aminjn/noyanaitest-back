import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// AI calls of the business suite (2026-10, Lib/business/financeAi.ts): one
// row per user, Tehran day, owner (the panel's books) and feature, counted
// with its failures and characters sent (a cost measure). Access and limits
// are the AI policy's, counted per feature in AiUsage (Lib/ai/aiGate.ts).
// Kept 90 days.
export const bizAiFeatures = ["receipt", "entry", "ask", "narrative", "categorize", "transcribe"] as const;
export type BizAiFeature = (typeof bizAiFeatures)[number];

export interface IBizAiUsage extends MongoDoc {
  user: mongoose.Types.ObjectId;
  // "YYYY-MM-DD" in Asia/Tehran
  day: string;
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  feature: BizAiFeature;
  count: number;
  // calls that failed (provider down, unreadable reply) - not counted
  failed: number;
  // characters sent and received, a rough cost measure
  charsIn: number;
  charsOut: number;
  provider?: string;
  model?: string;
  createdAt: Date;
}

const BizAiUsageSchema = new mongoose.Schema<IBizAiUsage, Model<IBizAiUsage>>(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    day: { type: String, required: true },
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    feature: { type: String, enum: bizAiFeatures, required: true },
    count: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    charsIn: { type: Number, default: 0 },
    charsOut: { type: Number, default: 0 },
    provider: { type: String },
    model: { type: String },
  },
  { timestamps: true },
);

BizAiUsageSchema.index({ user: 1, day: 1, ownerKind: 1, ownerId: 1, feature: 1 }, { unique: true });
BizAiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

const BizAiUsage = mongoose.model("BizAiUsage", BizAiUsageSchema);
export default BizAiUsage;
