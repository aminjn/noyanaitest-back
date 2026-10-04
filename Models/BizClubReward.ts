import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A reward of an owner's loyalty club (2026-10): so many points buy a
// percent or an amount off an invoice (capped by maxDiscount), redeemed by
// the patient in their own panel or by the desk (Models/BizClubRedemption.ts).
export const bizRewardKinds = ["percent", "amount"] as const;

export interface IBizClubReward extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  points: number;
  kind: (typeof bizRewardKinds)[number];
  // percent (1-100) or toman
  value: number;
  // toman; 0 = no cap
  maxDiscount: number;
  active: boolean;
  createdBy?: IUser;
  createdAt: Date;
}

const BizClubRewardSchema = new mongoose.Schema<IBizClubReward, Model<IBizClubReward>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 300 },
    points: { type: Number, required: true, min: 1, max: 1_000_000 },
    kind: { type: String, enum: bizRewardKinds, default: "percent" },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: { type: Number, min: 0, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizClubRewardSchema.index({ ownerKind: 1, ownerId: 1, points: 1 });

const BizClubReward = mongoose.model("BizClubReward", BizClubRewardSchema);
export default BizClubReward;
