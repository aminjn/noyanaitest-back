import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One owner's patient loyalty club (2026-10, Lib/business/crmService/
// club.ts), nexxacrm's «باشگاه مشتریان»: a point for every `pointUnit`
// toman the patient paid (visits and orders on Noyan, paid manual
// invoices), tiers by the total paid, each tier with its own discount
// percent, and rewards a patient buys with points (Models/BizClubReward.ts).
export const bizClubTierKeys = ["basic", "bronze", "silver", "gold", "platinum"] as const;
export type BizClubTierKey = (typeof bizClubTierKeys)[number];

// what a tier's threshold counts (2026-10): the total paid (toman), or the
// attended visits / delivered orders - a club that earns per visit ranks
// by visits too (Snapp Club, Digikala Club rank by activity, not only by
// money). A club saved before this had no basis: Lib/business/crmService/
// club.ts clubSettings picks it from the earning rule.
export const bizClubTierBases = ["amount", "visits"] as const;
export type BizClubTierBasis = (typeof bizClubTierBases)[number];

export interface IBizClubTier {
  key: BizClubTierKey;
  // from which total paid (toman) - or how many visits / orders, by the
  // club's tierBasis - a patient is in this tier
  min: number;
  // percent off an invoice for members of this tier
  discount: number;
}

export interface IBizClubSettings extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  enabled: boolean;
  // toman paid per point (0: no points by amount)
  pointUnit: number;
  // points per attended visit or completed order (2026-10): a practice's
  // club rewards visits, a pharmacy's purchases (the contact's visits and
  // orders); 0 or missing = none, so older clubs earn as before
  perVisit: number;
  tierBasis?: BizClubTierBasis;
  tiers: IBizClubTier[];
  // days a redeemed reward's code stays valid
  codeDays: number;
  createdAt: Date;
}

const TierSchema = new mongoose.Schema<IBizClubTier>(
  {
    key: { type: String, enum: bizClubTierKeys, required: true },
    min: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, max: 100, default: 0 },
  },
  { _id: false },
);

// toman: bronze from 5 m, silver 20 m, gold 50 m, platinum 100 m (nexxacrm's
// rial thresholds / 10)
export const defaultClubTiers = (): IBizClubTier[] => [
  { key: "platinum", min: 100_000_000, discount: 15 },
  { key: "gold", min: 50_000_000, discount: 10 },
  { key: "silver", min: 20_000_000, discount: 5 },
  { key: "bronze", min: 5_000_000, discount: 2 },
  { key: "basic", min: 0, discount: 0 },
];

// by visits / orders: bronze from the 3rd, silver 10th, gold 25th, platinum 50th
export const defaultVisitTiers = (): IBizClubTier[] => [
  { key: "platinum", min: 50, discount: 15 },
  { key: "gold", min: 25, discount: 10 },
  { key: "silver", min: 10, discount: 5 },
  { key: "bronze", min: 3, discount: 2 },
  { key: "basic", min: 0, discount: 0 },
];

const BizClubSettingsSchema = new mongoose.Schema<IBizClubSettings, Model<IBizClubSettings>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    enabled: { type: Boolean, default: false },
    pointUnit: { type: Number, min: 0, max: 100_000_000, default: 10_000 },
    perVisit: { type: Number, min: 0, max: 100_000, default: 0 },
    // no default: a missing basis follows the earning rule (clubSettings)
    tierBasis: { type: String, enum: bizClubTierBases },
    tiers: { type: [TierSchema], default: defaultClubTiers },
    codeDays: { type: Number, min: 1, max: 365, default: 30 },
  },
  { timestamps: true },
);

BizClubSettingsSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });

const BizClubSettings = mongoose.model("BizClubSettings", BizClubSettingsSchema);
export default BizClubSettings;
