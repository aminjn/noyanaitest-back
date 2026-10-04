import mongoose from "mongoose";
import { MongoDoc } from "./User";

// One plan period a provider bought (2026-10): the history behind the
// single <Kind>ProfileLicense record (one per provider, overwritten on each
// purchase). What the period cost (`value`: the quoted price, promotions
// included, before any upgrade credit) is what a later mid-term upgrade
// credits back per remaining day (Lib/licenseQuote.ts). An upgraded period
// is ended here with `endReason: "upgraded"` and kept.
export interface ILicensePurchase extends MongoDoc {
  kind: string;
  owner: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  plan: mongoose.Types.ObjectId;
  days: number;
  listPrice: number;
  // the quoted price of the option (own discount + promotion)
  value: number;
  // the unused value of the plan this one replaced (an upgrade)
  upgradeCredit: number;
  // what left the wallet: value - upgradeCredit, never below 0
  paid: number;
  promotion?: mongoose.Types.ObjectId;
  upgradedFrom?: mongoose.Types.ObjectId;
  startedAt: Date;
  expiresAt: Date;
  status: "active" | "ended";
  endedAt?: Date;
  endReason?: "upgraded";
  upgradedTo?: mongoose.Types.ObjectId;
}

const LicensePurchaseSchema = new mongoose.Schema<ILicensePurchase>(
  {
    kind: { type: String, required: true },
    owner: { type: mongoose.Schema.ObjectId, required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    plan: { type: mongoose.Schema.ObjectId, required: true },
    days: { type: Number, required: true },
    listPrice: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    upgradeCredit: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    promotion: { type: mongoose.Schema.ObjectId, ref: "LicensePromotion" },
    upgradedFrom: { type: mongoose.Schema.ObjectId, ref: "LicensePurchase" },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ["active", "ended"], default: "active" },
    endedAt: { type: Date },
    endReason: { type: String, enum: ["upgraded"] },
    upgradedTo: { type: mongoose.Schema.ObjectId, ref: "LicensePurchase" },
  },
  { timestamps: true },
);
LicensePurchaseSchema.index({ kind: 1, owner: 1, status: 1 });

const LicensePurchase = mongoose.model("LicensePurchase", LicensePurchaseSchema);

export default LicensePurchase;
