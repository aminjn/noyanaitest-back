import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ITransaction } from "./Transaction";

// Moving wallet money to a bank account (2026-09): anyone with a balance -
// a doctor's payouts, a pharmacy's or lab's sales, a patient's refunds -
// asks for a transfer to their Sheba (IBAN). The amount is held (debited)
// the moment the request is made, so it can't be spent twice; an admin
// transfers it and records the bank reference, or rejects it and the hold
// goes back to the wallet. Like Snapp / Digikala / Paziresh24 settlements.
export const withdrawalStatuses = [
  "pending",
  "paid",
  "rejected",
  "cancelled",
] as const;
export type WithdrawalStatus = (typeof withdrawalStatuses)[number];

export interface IWithdrawalRequest extends MongoDoc {
  user: IUser;
  amount: number;
  iban: string;
  holderName: string;
  status: WithdrawalStatus;
  // the hold (negative) and, when rejected, the return (positive)
  holdTransaction?: ITransaction;
  refundTransaction?: ITransaction;
  // bank transfer reference, set when paid
  trackingCode?: string;
  adminNote?: string;
  decidedBy?: IUser;
  decidedAt?: Date;
  // the bank payment is in the books (Lib/business/ledgerPoster.ts)
  bizPaidPostedAt?: Date;
  createdAt: Date;
}

const WithdrawalRequestSchema = new mongoose.Schema<
  IWithdrawalRequest,
  Model<IWithdrawalRequest>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true, min: 1 },
  iban: { type: String, required: true, trim: true },
  holderName: { type: String, required: true, trim: true, maxlength: 100 },
  status: { type: String, enum: withdrawalStatuses, default: "pending" },
  holdTransaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  refundTransaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  trackingCode: { type: String, trim: true, maxlength: 100 },
  adminNote: { type: String, trim: true, maxlength: 1000 },
  decidedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  decidedAt: { type: Date },
  bizPaidPostedAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
});

WithdrawalRequestSchema.index({ user: 1, createdAt: -1 });
WithdrawalRequestSchema.index({ status: 1, createdAt: 1 });
// one request in review per user (withdrawalController.createWithdrawal):
// two simultaneous requests can't both hold money
WithdrawalRequestSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: "pending" }, name: "onePendingPerUser" },
);

const WithdrawalRequest = mongoose.model(
  "WithdrawalRequest",
  WithdrawalRequestSchema,
);

export default WithdrawalRequest;
