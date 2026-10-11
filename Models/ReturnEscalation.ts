import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// A return the seller turned down (or never answered) that the buyer took
// to support (2026-10, Models/OrderReturn.ts). It lives in the super
// admin's one provider-requests queue (/requests, group "return"), with the
// queue's one-way actions: approve (the return goes ahead - or, when the
// goods are already back with the seller, the refund is made), reject with
// a reason the buyer is told (the return is declined), reopen a rejected
// one. Statuses use the queue's own words.
export const returnEscalationStatuses = ["Pending", "Approved", "Rejected"] as const;
export type ReturnEscalationStatus = (typeof returnEscalationStatuses)[number];

export interface IReturnEscalation extends MongoDoc {
  orderReturn: mongoose.Types.ObjectId;
  order: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  sellerKind: "pharmacy" | "paraClinic";
  seller: mongoose.Types.ObjectId;
  // what the buyer wrote, or why the platform raised it ("noResponse")
  note?: string;
  raisedBy: "buyer" | "system";
  status: ReturnEscalationStatus;
  rejectReason?: string;
  decidedAt?: Date;
  decidedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ReturnEscalationSchema = new mongoose.Schema<IReturnEscalation, Model<IReturnEscalation>>(
  {
    orderReturn: { type: mongoose.Schema.ObjectId, ref: "OrderReturn", required: true },
    order: { type: mongoose.Schema.ObjectId, ref: "Order", required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    sellerKind: { type: String, enum: ["pharmacy", "paraClinic"], required: true },
    seller: { type: mongoose.Schema.ObjectId, required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    raisedBy: { type: String, enum: ["buyer", "system"], default: "buyer" },
    status: { type: String, enum: returnEscalationStatuses, default: "Pending" },
    rejectReason: { type: String, trim: true, maxlength: 500 },
    decidedAt: { type: Date },
    decidedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// one open escalation per return
ReturnEscalationSchema.index({ orderReturn: 1 }, { unique: true });
ReturnEscalationSchema.index({ status: 1, createdAt: 1 });

const ReturnEscalation = mongoose.model("ReturnEscalation", ReturnEscalationSchema);

export default ReturnEscalation;
