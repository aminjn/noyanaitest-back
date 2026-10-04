import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";
import { BizInsurerKind, bizInsurerKinds } from "./BizInvoice";

// An insurance claim (لیست ارسالی به بیمه) of one provider (2026-10,
// Lib/business/claims.ts): the insurer's share of a period's visits and
// services, sent to Tamin, Salamat, the armed forces' insurer or a
// supplementary insurer, then paid - usually months later and usually with
// deductions (کسورات). Items from invoices are already booked to
// «مطالبات از بیمه‌ها»; an item typed into the claim is booked when the
// claim is submitted.
//   draft     - being put together (to submit)
//   submitted - sent, nothing back yet
//   partial   - part paid or deducted, the rest still open
//   paid      - nothing open, something was paid
//   rejected  - nothing open, nothing paid: all deducted with the reason
export const bizClaimStatuses = ["draft", "submitted", "partial", "paid", "rejected"] as const;
export type BizClaimStatus = (typeof bizClaimStatuses)[number];

export interface IBizClaimItem {
  invoice?: mongoose.Types.ObjectId;
  date: Date;
  patient: string;
  service: string;
  total: number;
  share: number;
}

export interface IBizClaim extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  insurer: { kind: BizInsurerKind; name: string };
  from?: Date;
  to?: Date;
  items: IBizClaimItem[];
  claimed: number;
  paid: number;
  deducted: number;
  status: BizClaimStatus;
  submittedAt?: Date;
  trackingCode?: string;
  rejectReason?: string;
  deductions: { amount: number; reason: string; at: Date }[];
  note?: string;
  // how many times it was submitted (its vouchers' refs carry it)
  round: number;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ItemSchema = new mongoose.Schema<IBizClaimItem>(
  {
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    date: { type: Date, required: true },
    patient: { type: String, trim: true, maxlength: 200, default: "" },
    service: { type: String, trim: true, maxlength: 300, default: "" },
    total: { type: Number, default: 0, min: 0 },
    share: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const BizClaimSchema = new mongoose.Schema<IBizClaim, Model<IBizClaim>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    insurer: {
      kind: { type: String, enum: bizInsurerKinds, default: "other" },
      name: { type: String, trim: true, maxlength: 120, default: "" },
    },
    from: { type: Date },
    to: { type: Date },
    items: { type: [ItemSchema], default: [] },
    claimed: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    deducted: { type: Number, default: 0 },
    status: { type: String, enum: bizClaimStatuses, default: "draft" },
    submittedAt: { type: Date },
    trackingCode: { type: String, trim: true, maxlength: 80 },
    rejectReason: { type: String, trim: true, maxlength: 500 },
    deductions: {
      type: [new mongoose.Schema({ amount: Number, reason: String, at: Date }, { _id: false })],
      default: [],
    },
    note: { type: String, trim: true, maxlength: 1000 },
    round: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizClaimSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizClaimSchema.index({ ownerKind: 1, ownerId: 1, status: 1 });

const BizClaim = mongoose.model("BizClaim", BizClaimSchema);
export default BizClaim;
