import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A staff commission rule (2026-10, Nexxa CommissionRule / commission.ts):
// a percent of the invoices the person (or, for a supervisor, their team)
// brought in, and of what was collected on them, flat or in tiers.
export interface IBizTier {
  from: number;
  pct: number;
}

export interface IBizCommissionRule extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  // a staff member, or (a clinic's / hospital's) one of its doctors
  user?: mongoose.Types.ObjectId;
  doctorName?: string;
  title: string;
  scope: "self" | "team";
  mode: "flat" | "tiered";
  tierMethod: "marginal" | "whole";
  salesTiers: IBizTier[];
  collectionTiers: IBizTier[];
  salesPct: number;
  collectionPct: number;
  period: "month" | "quarter" | "year" | "custom";
  periodStart: Date;
  periodEnd: Date;
  active: boolean;
  createdAt: Date;
}

const TierSchema = new mongoose.Schema<IBizTier>({ from: { type: Number, min: 0, default: 0 }, pct: { type: Number, min: 0, max: 100, default: 0 } }, { _id: false });

const BizCommissionRuleSchema = new mongoose.Schema<IBizCommissionRule, Model<IBizCommissionRule>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    doctorName: { type: String, trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    scope: { type: String, enum: ["self", "team"], default: "self" },
    mode: { type: String, enum: ["flat", "tiered"], default: "flat" },
    tierMethod: { type: String, enum: ["marginal", "whole"], default: "marginal" },
    salesTiers: { type: [TierSchema], default: [] },
    collectionTiers: { type: [TierSchema], default: [] },
    salesPct: { type: Number, default: 0, min: 0, max: 100 },
    collectionPct: { type: Number, default: 0, min: 0, max: 100 },
    period: { type: String, enum: ["month", "quarter", "year", "custom"], default: "month" },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BizCommissionRuleSchema.index({ ownerKind: 1, ownerId: 1, active: 1 });

const BizCommissionRule = mongoose.model("BizCommissionRule", BizCommissionRuleSchema);
export default BizCommissionRule;
