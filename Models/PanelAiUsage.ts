import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// AI requests one panel user made on one Tehran calendar day (2026-10,
// Lib/ai/panelAi.ts): the copilot «دستیار نویان», voice prescription, chat
// reply suggestions, patient summaries, CRM texts and call analysis. The
// per-user daily safety limit (AppConfig.panelAiDailyLimit) is checked
// against `count`; `features` keeps the split for the admin's usage view.
// A counter of its own (not AiDailyUsage, which is the patient assistant's).
export interface IPanelAiUsage extends MongoDoc {
  user: mongoose.Types.ObjectId;
  // "YYYY-MM-DD" in Asia/Tehran
  day: string;
  count: number;
  features: Record<string, number>;
  createdAt: Date;
}

const PanelAiUsageSchema = new mongoose.Schema<IPanelAiUsage, Model<IPanelAiUsage>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  day: { type: String, required: true },
  count: { type: Number, default: 0, min: 0 },
  features: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
});

PanelAiUsageSchema.index({ user: 1, day: 1 }, { unique: true });
PanelAiUsageSchema.index({ day: 1 });
// only the recent days matter
PanelAiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

const PanelAiUsage = mongoose.model("PanelAiUsage", PanelAiUsageSchema);

export default PanelAiUsage;
