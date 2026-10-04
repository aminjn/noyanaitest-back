import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One «پرو» membership period a user bought (2026-10, Models/PatientProPlan
// .ts). A renewal while a period still runs starts where it ends, so the
// periods of one user never overlap; a user is Pro while one of them holds
// now (Lib/patientPro.ts proStatusOf). The hourly job
// (Services/patientProService.ts) marks ended periods "expired" and sends
// the renewal reminders.
export const patientSubscriptionStatuses = ["active", "expired", "cancelled"] as const;
export type PatientSubscriptionStatus = (typeof patientSubscriptionStatuses)[number];

export interface IPatientSubscription extends MongoDoc {
  user: mongoose.Types.ObjectId;
  plan: mongoose.Types.ObjectId;
  days: number;
  startedAt: Date;
  expiresAt: Date;
  status: PatientSubscriptionStatus;
  // the option's list price, what it cost after discounts and what left the
  // wallet (the same numbers as LicensePurchase)
  listPrice: number;
  value: number;
  paid: number;
  promotion?: mongoose.Types.ObjectId;
  transaction?: mongoose.Types.ObjectId;
  // a support grant (no payment)
  grantedBy?: mongoose.Types.ObjectId;
  note?: string;
  cancelledAt?: Date;
  cancelledBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PatientSubscriptionSchema = new mongoose.Schema<
  IPatientSubscription,
  Model<IPatientSubscription>
>(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    plan: { type: mongoose.Schema.ObjectId, ref: "PatientProPlan", required: true },
    days: { type: Number, required: true, min: 1 },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: patientSubscriptionStatuses, default: "active" },
    listPrice: { type: Number, default: 0, min: 0 },
    value: { type: Number, default: 0, min: 0 },
    paid: { type: Number, default: 0, min: 0 },
    promotion: { type: mongoose.Schema.ObjectId, ref: "LicensePromotion" },
    transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
    grantedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    note: { type: String, maxlength: 500 },
    cancelledAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

PatientSubscriptionSchema.index({ user: 1, status: 1, expiresAt: -1 });
PatientSubscriptionSchema.index({ status: 1, expiresAt: 1 });

const PatientSubscription = mongoose.model("PatientSubscription", PatientSubscriptionSchema);

export default PatientSubscription;
