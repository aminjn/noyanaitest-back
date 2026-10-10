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

// (2026-10) the insurer's decision on one line, when the list went to an
// insurer that reviews it on Noyan (Lib/business/insurerClaims.ts)
export const bizClaimLineDecisions = ["accepted", "deducted", "rejected"] as const;
export type BizClaimLineDecision = (typeof bizClaimLineDecisions)[number];

export interface IBizClaimItem {
  invoice?: mongoose.Types.ObjectId;
  // (2026-10) an insurer's share of a visit booked and paid on Noyan
  // (Reservation.insuranceQuote.lines[line]): already in the books
  reservation?: mongoose.Types.ObjectId;
  line?: number;
  // (2026-10) a supplementary insurer's share of a cart order line a
  // pharmacy / lab sold on Noyan (Lib/business/orderInsurance.ts): already
  // in the books
  order?: mongoose.Types.ObjectId;
  orderLine?: mongoose.Types.ObjectId;
  date: Date;
  patient: string;
  service: string;
  total: number;
  share: number;
  decision?: { status: BizClaimLineDecision; approved: number; deducted: number; reason?: string };
}

// The insurer's side of a list sent to an insurer with a Noyan profile
// (Salamat / Tamin portals' رسیدگی): it arrives pending, the insurer
// decides each line (accept, deduct with a reason, reject), registers the
// result once (decided, with its date), then pays what it accepted, in one
// or several payments (paid when nothing accepted is left).
export const bizClaimReviewStatuses = ["pending", "decided", "paid"] as const;
export type BizClaimReviewStatus = (typeof bizClaimReviewStatuses)[number];

export interface IBizClaimReview {
  status: BizClaimReviewStatus;
  receivedAt: Date;
  decidedAt?: Date;
  decidedBy?: mongoose.Types.ObjectId;
  // the decision's attempt: its vouchers' refs carry it
  seq: number;
  approved: number;
  deducted: number;
  paid: number;
  note?: string;
  payments: {
    _id: mongoose.Types.ObjectId;
    key?: string;
    amount: number;
    date: Date;
    money: mongoose.Types.ObjectId;
    reference?: string;
    centrePayment?: mongoose.Types.ObjectId;
    by?: mongoose.Types.ObjectId;
  }[];
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
  // (2026-10) the insurer's Noyan profile the list is sent to, the
  // centre's name as the insurer sees it, and the insurer's review
  insurerProfile?: mongoose.Types.ObjectId;
  centreName?: string;
  review?: IBizClaimReview;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ItemSchema = new mongoose.Schema<IBizClaimItem>(
  {
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    line: { type: Number, min: 0 },
    order: { type: mongoose.Schema.ObjectId, ref: "Order" },
    orderLine: { type: mongoose.Schema.ObjectId },
    date: { type: Date, required: true },
    patient: { type: String, trim: true, maxlength: 200, default: "" },
    service: { type: String, trim: true, maxlength: 300, default: "" },
    total: { type: Number, default: 0, min: 0 },
    share: { type: Number, default: 0, min: 0 },
    decision: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: bizClaimLineDecisions, required: true },
          approved: { type: Number, default: 0, min: 0 },
          deducted: { type: Number, default: 0, min: 0 },
          reason: { type: String, trim: true, maxlength: 300 },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { _id: false },
);

const ReviewSchema = new mongoose.Schema<IBizClaimReview>(
  {
    status: { type: String, enum: bizClaimReviewStatuses, default: "pending" },
    receivedAt: { type: Date, default: () => new Date() },
    decidedAt: { type: Date },
    decidedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    seq: { type: Number, default: 0 },
    approved: { type: Number, default: 0 },
    deducted: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    note: { type: String, trim: true, maxlength: 1000 },
    payments: {
      type: [
        new mongoose.Schema({
          key: { type: String, maxlength: 80 },
          amount: { type: Number, required: true, min: 0 },
          date: { type: Date, required: true },
          money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount", required: true },
          reference: { type: String, trim: true, maxlength: 80 },
          centrePayment: { type: mongoose.Schema.ObjectId, ref: "BizPayment" },
          by: { type: mongoose.Schema.ObjectId, ref: "User" },
        }),
      ],
      default: [],
    },
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
    insurerProfile: { type: mongoose.Schema.ObjectId, ref: "Insurance" },
    centreName: { type: String, trim: true, maxlength: 200 },
    review: { type: ReviewSchema, default: undefined },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizClaimSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizClaimSchema.index({ ownerKind: 1, ownerId: 1, status: 1 });
// the insurer's queue of lists received from centres
BizClaimSchema.index({ insurerProfile: 1, "review.status": 1, submittedAt: -1 }, { partialFilterExpression: { insurerProfile: { $exists: true } } });

const BizClaim = mongoose.model("BizClaim", BizClaimSchema);
export default BizClaim;
