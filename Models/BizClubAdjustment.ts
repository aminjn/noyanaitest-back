import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Points given or taken by hand or by a workflow (2026-10): a welcome
// bonus, a correction. The balance is what the patient paid, in points,
// plus these, minus the points held by their rewards.
export interface IBizClubAdjustment extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  points: number;
  reason: string;
  // a workflow's run, so one event gives its bonus once
  dedupeKey?: string;
  createdBy?: IUser;
  createdAt: Date;
}

const BizClubAdjustmentSchema = new mongoose.Schema<IBizClubAdjustment, Model<IBizClubAdjustment>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    points: { type: Number, required: true, min: -1_000_000, max: 1_000_000 },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
    dedupeKey: String,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizClubAdjustmentSchema.index({ ownerKind: 1, ownerId: 1, contact: 1 });
BizClubAdjustmentSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });

const BizClubAdjustment = mongoose.model("BizClubAdjustment", BizClubAdjustmentSchema);
export default BizClubAdjustment;
