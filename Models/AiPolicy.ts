import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// «سیاست هوش مصنوعی» (2026-10, Lib/ai/aiPolicy.ts): the super admin's one
// control over every AI feature of the platform (Lib/ai/aiFeatures.ts).
// A singleton. `features` holds only what the admin set; a feature not in
// it follows the registry's defaults (which reproduce the rules from before
// the policy existed).
export type AiPolicyMode = "free" | "plan" | "off";

export interface IAiPolicy extends MongoDoc {
  singleton: "SINGLETON";
  // the master switch: off = no AI anywhere, internal tools included
  enabled: boolean;
  // the user-facing paywall: "free" = plan gates are lifted (limits stay),
  // "plan" = each feature's own access, "off" = no AI for patients and
  // providers (staff and content tools keep working)
  mode: AiPolicyMode;
  // featureKey -> { access, modules, pro, limits }
  features: Record<string, unknown>;
  // the numbers the old settings held when the policy was made
  // (AppConfig.panelAiDailyLimit, PatientProPlan.freeAiDailyLimit /
  // proAiDailyLimit): a feature added to the registry later starts from them
  legacy?: { panel?: number; patientFree?: number; patientPro?: number };
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt?: Date;
  createdAt?: Date;
}

const AiPolicySchema = new mongoose.Schema<IAiPolicy, Model<IAiPolicy>>(
  {
    singleton: { type: String, enum: ["SINGLETON"], default: "SINGLETON", unique: true },
    enabled: { type: Boolean, default: true },
    mode: { type: String, enum: ["free", "plan", "off"], default: "plan" },
    features: { type: mongoose.Schema.Types.Mixed, default: {} },
    legacy: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true, minimize: false },
);

const AiPolicy = mongoose.model("AiPolicy", AiPolicySchema);
export default AiPolicy;
