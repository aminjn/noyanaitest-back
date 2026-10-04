import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A corporate or insurer contract (2026-10, Nexxa Contract): a company's
// staff check-up, a supplementary-insurance agreement, a supply contract.
// The other side is a company (party) or one of the owner's patients
// (contact). Signed from its public link (/ct/<token>) it becomes active;
// it is invoiced once; past its end it expires, with a renewal reminder
// 30 days before.
export const bizContractStates = ["draft", "active", "expired", "canceled"] as const;

export interface IBizContract extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  subject: string;
  contact?: mongoose.Types.ObjectId;
  party: { name: string; phone?: string; nationalId?: string; kind: "company" | "insurer" | "person" };
  type?: mongoose.Types.ObjectId;
  value: number;
  startDate: Date;
  endDate?: Date;
  state: (typeof bizContractStates)[number];
  signed: boolean;
  signedAt?: Date;
  signerName?: string;
  signature?: string;
  acceptedIp?: string;
  content?: string;
  note?: string;
  invoice?: mongoose.Types.ObjectId;
  token: string;
  renewNotifiedAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizContractSchema = new mongoose.Schema<IBizContract, Model<IBizContract>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    party: {
      name: { type: String, trim: true, maxlength: 200, default: "" },
      phone: { type: String, trim: true, maxlength: 20 },
      nationalId: { type: String, trim: true, maxlength: 20 },
      kind: { type: String, enum: ["company", "insurer", "person"], default: "company" },
    },
    type: { type: mongoose.Schema.ObjectId, ref: "BizContentBlock" },
    value: { type: Number, default: 0, min: 0 },
    startDate: { type: Date, default: () => new Date() },
    endDate: Date,
    state: { type: String, enum: bizContractStates, default: "draft" },
    signed: { type: Boolean, default: false },
    signedAt: Date,
    signerName: { type: String, trim: true, maxlength: 120 },
    signature: { type: String, maxlength: 420_000 },
    acceptedIp: { type: String, maxlength: 60 },
    content: { type: String, maxlength: 60_000 },
    note: { type: String, trim: true, maxlength: 2000 },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    token: { type: String, required: true, unique: true },
    renewNotifiedAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizContractSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizContractSchema.index({ ownerKind: 1, ownerId: 1, state: 1 });
BizContractSchema.index({ state: 1, endDate: 1 });

const BizContract = mongoose.model("BizContract", BizContractSchema);
export default BizContract;
