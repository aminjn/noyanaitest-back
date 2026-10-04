import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A reward taken with points (2026-10, Lib/business/crmService/club.ts):
// the points are held from the moment it is taken; the desk applies its
// code to a draft invoice of the patient (a real line discount through
// Lib/business/invoices.ts), and the code is spent once that invoice is
// issued. Cancelling it, or voiding / deleting its invoice, gives the
// points back.
//   issued -> applied -> used
//   issued | applied -> cancelled ; issued -> expired
export const bizRedemptionStatuses = ["issued", "applied", "used", "cancelled", "expired"] as const;
export type BizRedemptionStatus = (typeof bizRedemptionStatuses)[number];

export interface IBizClubRedemption extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  reward?: mongoose.Types.ObjectId;
  // the reward as it was when taken
  name: string;
  kind: "percent" | "amount" | "tier";
  value: number;
  maxDiscount: number;
  points: number;
  code: string;
  status: BizRedemptionStatus;
  invoice?: mongoose.Types.ObjectId;
  // the discount it put on the invoice (toman), and each line's share
  discountAmount: number;
  lineDiscounts: number[];
  expiresAt?: Date;
  usedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  // the patient took it (their account) or a staff member did
  byPatient: boolean;
  createdBy?: IUser;
  createdAt: Date;
}

const BizClubRedemptionSchema = new mongoose.Schema<IBizClubRedemption, Model<IBizClubRedemption>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    reward: { type: mongoose.Schema.ObjectId, ref: "BizClubReward" },
    name: { type: String, required: true, maxlength: 80 },
    kind: { type: String, enum: ["percent", "amount", "tier"], required: true },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: 0 },
    points: { type: Number, default: 0, min: 0 },
    code: { type: String, required: true, unique: true },
    status: { type: String, enum: bizRedemptionStatuses, default: "issued" },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    discountAmount: { type: Number, default: 0 },
    lineDiscounts: { type: [Number], default: [] },
    expiresAt: Date,
    usedAt: Date,
    cancelledAt: Date,
    cancelReason: { type: String, maxlength: 300 },
    byPatient: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizClubRedemptionSchema.index({ ownerKind: 1, ownerId: 1, contact: 1, status: 1 });
BizClubRedemptionSchema.index({ ownerKind: 1, ownerId: 1, invoice: 1 });
BizClubRedemptionSchema.index({ status: 1, expiresAt: 1 });

const BizClubRedemption = mongoose.model("BizClubRedemption", BizClubRedemptionSchema);
export default BizClubRedemption;
