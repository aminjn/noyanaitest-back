import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Messages a user sent to the AI health assistant on one Tehran calendar
// day (2026-10, Lib/patientPro.ts consumeAiMessage): the free tier's daily
// limit and a Pro member's fair-use cap. A counter of its own, not a count
// of BotChatMessage rows, so deleting a chat does not give the day back.
// Replaced by AiUsage (2026-10, the AI policy, feature "assistant.health");
// read once by Lib/migrateAiPolicy.ts.
export interface IAiDailyUsage extends MongoDoc {
  user: mongoose.Types.ObjectId;
  // "YYYY-MM-DD" in Asia/Tehran
  day: string;
  count: number;
  createdAt: Date;
}

const AiDailyUsageSchema = new mongoose.Schema<IAiDailyUsage, Model<IAiDailyUsage>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  day: { type: String, required: true },
  count: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: () => new Date() },
});

AiDailyUsageSchema.index({ user: 1, day: 1 }, { unique: true });
// only the recent days matter
AiDailyUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 40 * 24 * 3600 });

const AiDailyUsage = mongoose.model("AiDailyUsage", AiDailyUsageSchema);

export default AiDailyUsage;
