import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A finance request on the approval desk (کارتابل مالی, 2026-10,
// Lib/business/requests.ts), after Nexxa's PettyCashRequest,
// ExpenseRequest, PaymentRequest, CheckIssueRequest, FundTransferRequest,
// ReturnRequest and SalesInvoiceApprovalRequest: a team member asks, the
// approvers in the chain decide one level after another, and the final
// approval applies the effect (the voucher) once - an atomic claim from
// "approved" to "done" so a double click never books twice.
export const bizRequestKinds = ["petty", "expense", "payment", "checkIssue", "fundTransfer", "return", "invoice"] as const;
export type BizRequestKind = (typeof bizRequestKinds)[number];
export const bizRequestStatuses = ["pending", "approved", "rejected", "cancelled", "done"] as const;

export interface IBizRequest extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  kind: BizRequestKind;
  number: number;
  requester?: mongoose.Types.ObjectId;
  requesterName?: string;
  amount: number;
  description?: string;
  status: (typeof bizRequestStatuses)[number];
  // the approvers, in order (team members' user ids) and the current level
  chain: mongoose.Types.ObjectId[];
  chainNames: string[];
  level: number;
  decisions: { by?: mongoose.Types.ObjectId; name?: string; level: number; decision: "approved" | "rejected"; note?: string; at: Date }[];
  // what the request is about
  money?: mongoose.Types.ObjectId;
  toMoney?: mongoose.Types.ObjectId;
  account?: mongoose.Types.ObjectId;
  center?: mongoose.Types.ObjectId;
  party?: mongoose.Types.ObjectId;
  partyName?: string;
  // payment: a payment or a remittance (حواله)
  payKind?: "payment" | "remittance";
  serial?: string;
  bank?: string;
  dueDate?: Date;
  invoice?: mongoose.Types.ObjectId;
  invoiceRef?: string;
  // what executing it produced
  voucherRef?: string;
  payment?: mongoose.Types.ObjectId;
  error?: string;
  executedAt?: Date;
  createdAt: Date;
}

const BizRequestSchema = new mongoose.Schema<IBizRequest, Model<IBizRequest>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    kind: { type: String, enum: bizRequestKinds, required: true },
    number: { type: Number, required: true },
    requester: { type: mongoose.Schema.ObjectId, ref: "User" },
    requesterName: { type: String, trim: true, maxlength: 120 },
    amount: { type: Number, default: 0, min: 0 },
    description: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: bizRequestStatuses, default: "pending" },
    chain: { type: [mongoose.Schema.ObjectId], default: [] },
    chainNames: { type: [String], default: [] },
    level: { type: Number, default: 0 },
    decisions: {
      type: [
        new mongoose.Schema(
          { by: mongoose.Schema.ObjectId, name: String, level: Number, decision: String, note: String, at: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
    toMoney: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    party: { type: mongoose.Schema.ObjectId, ref: "BizParty" },
    partyName: { type: String, trim: true, maxlength: 200 },
    payKind: { type: String, enum: ["payment", "remittance"] },
    serial: { type: String, trim: true, maxlength: 40 },
    bank: { type: String, trim: true, maxlength: 80 },
    dueDate: Date,
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    invoiceRef: { type: String, trim: true, maxlength: 60 },
    voucherRef: String,
    payment: { type: mongoose.Schema.ObjectId, ref: "BizPayment" },
    error: { type: String, maxlength: 300 },
    executedAt: Date,
  },
  { timestamps: true },
);
BizRequestSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, number: 1 }, { unique: true });
BizRequestSchema.index({ ownerKind: 1, ownerId: 1, status: 1, createdAt: -1 });

const BizRequest = mongoose.model("BizRequest", BizRequestSchema);
export default BizRequest;
