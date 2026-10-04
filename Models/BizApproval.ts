import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A request that waits for the centre manager (2026-10, Nexxa
// approval-chain.ts with DiscountRequest, CreditLimitRequest and
// ProformaApprovalRequest): a treatment plan to send, a discount on a plan
// or a draft invoice, a patient's credit limit. It walks its chain one
// approver at a time; the final approval applies its effect (applied).
export const bizApprovalKinds = ["plan", "discount", "credit"] as const;

export interface IBizApproval extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: (typeof bizApprovalKinds)[number];
  number: number;
  requester?: mongoose.Types.ObjectId;
  contact?: mongoose.Types.ObjectId;
  plan?: mongoose.Types.ObjectId;
  invoice?: mongoose.Types.ObjectId;
  amount: number;
  percent: number;
  requestedLimit: number;
  description?: string;
  chain: mongoose.Types.ObjectId[];
  level: number;
  status: "pending" | "approved" | "rejected" | "cancelled" | "applied";
  decisions: { by?: mongoose.Types.ObjectId; decision: "approved" | "rejected"; note?: string; at: Date }[];
  appliedAt?: Date;
  createdAt: Date;
}

const BizApprovalSchema = new mongoose.Schema<IBizApproval, Model<IBizApproval>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: bizApprovalKinds, required: true },
    number: { type: Number, required: true },
    requester: { type: mongoose.Schema.ObjectId, ref: "User" },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    plan: { type: mongoose.Schema.ObjectId, ref: "BizPlan" },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    amount: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0, max: 100 },
    requestedLimit: { type: Number, default: 0, min: 0 },
    description: { type: String, trim: true, maxlength: 1000 },
    chain: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
    level: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled", "applied"], default: "pending" },
    decisions: {
      type: [
        new mongoose.Schema(
          { by: mongoose.Schema.ObjectId, decision: { type: String, enum: ["approved", "rejected"] }, note: String, at: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    appliedAt: Date,
  },
  { timestamps: true },
);

BizApprovalSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, status: 1, createdAt: -1 });
BizApprovalSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, number: 1 }, { unique: true });

const BizApproval = mongoose.model("BizApproval", BizApprovalSchema);
export default BizApproval;
