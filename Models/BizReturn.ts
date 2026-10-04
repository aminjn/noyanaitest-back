import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A return or refund request (2026-10, Lib/business/crmService/returns.ts),
// nexxacrm's service_return_request and after_sales_service_request in
// one: a service complaint refunded in cash or as a credit note, or a
// pharmacy's returned goods refunded, repaired or replaced. It goes
// through the approvers in order (the inbox); once approved, "process"
// books it - and "void" books the reverse (and puts stock back).
//   pending -> approved -> processed (-> voided) ; pending -> rejected ;
//   pending | approved -> cancelled
// A visit or order paid with the Noyan wallet is refunded through Noyan's
// own dispute flow, never here.
export const bizReturnKinds = ["service", "goods"] as const;
export const bizReturnActions = ["refund", "credit", "repair", "replace"] as const;
export const bizReturnStatuses = ["pending", "approved", "processed", "rejected", "cancelled", "voided"] as const;

export interface IBizReturn extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  kind: (typeof bizReturnKinds)[number];
  action: (typeof bizReturnActions)[number];
  contact?: mongoose.Types.ObjectId;
  invoice?: mongoose.Types.ObjectId;
  item?: mongoose.Types.ObjectId;
  amount: number;
  // refund / repair: paid from the till or the bank
  payFrom: "cash" | "bank";
  reason?: string;
  approverChain: mongoose.Types.ObjectId[];
  currentLevel: number;
  status: (typeof bizReturnStatuses)[number];
  requester: mongoose.Types.ObjectId;
  voucherRef?: string;
  stockRef?: string;
  processedAt?: Date;
  voidedAt?: Date;
  rejectReason?: string;
  createdAt: Date;
}

const BizReturnSchema = new mongoose.Schema<IBizReturn, Model<IBizReturn>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    kind: { type: String, enum: bizReturnKinds, required: true },
    action: { type: String, enum: bizReturnActions, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    item: { type: mongoose.Schema.ObjectId, ref: "BizItem" },
    amount: { type: Number, min: 0, default: 0 },
    payFrom: { type: String, enum: ["cash", "bank"], default: "cash" },
    reason: { type: String, trim: true, maxlength: 1000 },
    approverChain: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
    currentLevel: { type: Number, default: 0 },
    status: { type: String, enum: bizReturnStatuses, default: "pending" },
    requester: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    voucherRef: String,
    stockRef: String,
    processedAt: Date,
    voidedAt: Date,
    rejectReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

BizReturnSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizReturnSchema.index({ ownerKind: 1, ownerId: 1, status: 1, createdAt: -1 });

const BizReturn = mongoose.model("BizReturn", BizReturnSchema);
export default BizReturn;
