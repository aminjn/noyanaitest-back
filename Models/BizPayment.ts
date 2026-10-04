import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Money received or paid by one owner (2026-10, Lib/business/payments.ts):
// a patient paying an invoice, an insurer paying a claim, a vendor paid for
// an expense, any other receipt or payment. Every one posts a balanced
// voucher; a cheque posts to «اسناد دریافتنی / پرداختنی» first and to the
// bank when it clears (or back to the party when it bounces).
export const bizPayMethods = ["cash", "card", "transfer", "cheque", "wallet"] as const;
export type BizPayMethod = (typeof bizPayMethods)[number];
// deposited: handed to the bank for collection, still a claim on the
// drawer (no voucher); endorsed: a received cheque passed on to a supplier
// (خرج چک, 2026-10 Lib/business/treasury.ts)
export const bizChequeStatuses = ["pending", "deposited", "cleared", "bounced", "returned", "endorsed"] as const;
export type BizChequeStatus = (typeof bizChequeStatuses)[number];
export const bizPayAgainst = ["invoice", "claim", "expense", "account"] as const;

export interface IBizCheque {
  number: string;
  bank: string;
  branch?: string;
  // the Sayad id (شناسه‌ی صیاد) of the cheque, 16 digits
  sayad?: string;
  dueDate: Date;
  status: BizChequeStatus;
  statusAt?: Date;
  // the bank account it was deposited to / drawn on (cleared)
  clearedTo?: mongoose.Types.ObjectId;
  remindedAt?: Date;
  // endorsed to (a supplier's party) and the cheque book it was drawn from
  endorsedTo?: mongoose.Types.ObjectId;
  endorsedToName?: string;
  checkbook?: mongoose.Types.ObjectId;
  history: { status: BizChequeStatus; at: Date; note?: string }[];
}

export interface IBizPayment extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  direction: "in" | "out";
  date: Date;
  amount: number;
  method: BizPayMethod;
  // the till / bank / POS (BizMoneyAccount) - for a cheque, where it will clear
  money?: mongoose.Types.ObjectId;
  against: (typeof bizPayAgainst)[number];
  invoice?: mongoose.Types.ObjectId;
  claim?: mongoose.Types.ObjectId;
  expense?: mongoose.Types.ObjectId;
  // the other side for a free receipt / payment (an income, expense,
  // payable... detail account)
  account?: mongoose.Types.ObjectId;
  party?: string;
  description?: string;
  reference?: string;
  cheque?: IBizCheque;
  isVoid: boolean;
  voidedAt?: Date;
  center?: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ChequeSchema = new mongoose.Schema<IBizCheque>(
  {
    number: { type: String, required: true, trim: true, maxlength: 40 },
    bank: { type: String, required: true, trim: true, maxlength: 80 },
    branch: { type: String, trim: true, maxlength: 80 },
    sayad: { type: String, trim: true, maxlength: 20 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: bizChequeStatuses, default: "pending" },
    statusAt: { type: Date },
    clearedTo: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
    remindedAt: { type: Date },
    endorsedTo: { type: mongoose.Schema.ObjectId, ref: "BizParty" },
    endorsedToName: { type: String, trim: true, maxlength: 200 },
    checkbook: { type: mongoose.Schema.ObjectId, ref: "BizCheckbook" },
    history: {
      type: [new mongoose.Schema({ status: String, at: Date, note: String }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

const BizPaymentSchema = new mongoose.Schema<IBizPayment, Model<IBizPayment>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: bizPayMethods, required: true },
    money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
    against: { type: String, enum: bizPayAgainst, required: true },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    claim: { type: mongoose.Schema.ObjectId, ref: "BizClaim" },
    expense: { type: mongoose.Schema.ObjectId, ref: "BizExpense" },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    party: { type: String, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 500 },
    reference: { type: String, trim: true, maxlength: 80 },
    cheque: { type: ChequeSchema, default: undefined },
    isVoid: { type: Boolean, default: false },
    voidedAt: { type: Date },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizPaymentSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizPaymentSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizPaymentSchema.index({ "cheque.status": 1, "cheque.dueDate": 1 });

const BizPayment = mongoose.model("BizPayment", BizPaymentSchema);
export default BizPayment;
