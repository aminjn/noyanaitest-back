import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One item of the owner's «کارتابل» (2026-10, Lib/business/kartabl.ts): the
// single approval queue of a panel. Every kind of request that waits for a
// decision lives here, told apart by `kind`:
//   finance (the accounting desk, Lib/business/requests.ts)
//     petty, expense, payment, checkIssue, fundTransfer, invoice
//   CRM sales (Lib/business/crmSales.ts)
//     plan (a treatment plan above the threshold), discount, credit
//   CRM service
//     return  (a return or refund, Lib/business/crmService/returns.ts - the
//              one owner of returns and credit notes)
//     flow    (an approval step of a workflow run, crmService/flow.ts)
// A team member asks; the approvers in `chain` decide one level after
// another (approve, or reject with a reason); the last approval applies the
// kind's effect once - an atomic claim from "approved" to "done" - so a
// double click or two approvers at once never book twice. A rejected item
// can be reopened (back to the first level); a pending or approved one can
// be cancelled by its requester or the owner.
//   pending -> approved -> done ; pending -> rejected -> pending (reopen) ;
//   pending | approved -> cancelled
export const bizFinanceRequestKinds = ["petty", "expense", "payment", "checkIssue", "fundTransfer", "invoice"] as const;
export const bizSalesRequestKinds = ["plan", "discount", "credit"] as const;
export const bizRequestKinds = [...bizFinanceRequestKinds, ...bizSalesRequestKinds, "return", "flow"] as const;
export type BizRequestKind = (typeof bizRequestKinds)[number];
export const bizRequestStatuses = ["pending", "approved", "rejected", "cancelled", "done"] as const;
export type BizRequestStatus = (typeof bizRequestStatuses)[number];

export interface IBizRequest extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  kind: BizRequestKind;
  number: number;
  requester?: mongoose.Types.ObjectId;
  requesterName?: string;
  // a workflow step's own words; the other kinds are titled by the panel
  title?: string;
  detail?: string;
  amount: number;
  percent: number;
  requestedLimit: number;
  description?: string;
  status: BizRequestStatus;
  // the approvers, in order (team members' user ids) and the current level
  chain: mongoose.Types.ObjectId[];
  chainNames: string[];
  level: number;
  decisions: { by?: mongoose.Types.ObjectId; name?: string; level: number; decision: "approved" | "rejected" | "reopened"; note?: string; at: Date }[];
  // when it was last approved or rejected, and the rejection's reason
  decidedAt?: Date;
  rejectReason?: string;
  // what the request is about
  money?: mongoose.Types.ObjectId;
  toMoney?: mongoose.Types.ObjectId;
  account?: mongoose.Types.ObjectId;
  center?: mongoose.Types.ObjectId;
  party?: mongoose.Types.ObjectId;
  partyName?: string;
  payKind?: "payment" | "remittance";
  serial?: string;
  bank?: string;
  dueDate?: Date;
  invoice?: mongoose.Types.ObjectId;
  invoiceRef?: string;
  contact?: mongoose.Types.ObjectId;
  plan?: mongoose.Types.ObjectId;
  returnDoc?: mongoose.Types.ObjectId;
  run?: mongoose.Types.ObjectId;
  step?: number;
  // what applying it produced
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
    title: { type: String, trim: true, maxlength: 300 },
    detail: { type: String, trim: true, maxlength: 1000 },
    amount: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0, max: 100 },
    requestedLimit: { type: Number, default: 0, min: 0 },
    description: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: bizRequestStatuses, default: "pending" },
    chain: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
    chainNames: { type: [String], default: [] },
    level: { type: Number, default: 0, min: 0 },
    decisions: {
      type: [
        new mongoose.Schema(
          { by: mongoose.Schema.ObjectId, name: String, level: Number, decision: { type: String, enum: ["approved", "rejected", "reopened"] }, note: String, at: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    decidedAt: Date,
    rejectReason: { type: String, trim: true, maxlength: 500 },
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
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    plan: { type: mongoose.Schema.ObjectId, ref: "BizPlan" },
    returnDoc: { type: mongoose.Schema.ObjectId, ref: "BizReturn" },
    run: { type: mongoose.Schema.ObjectId, ref: "BizFlowRun" },
    step: Number,
    voucherRef: String,
    payment: { type: mongoose.Schema.ObjectId, ref: "BizPayment" },
    error: { type: String, maxlength: 300 },
    executedAt: Date,
  },
  { timestamps: true },
);
BizRequestSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, number: 1 }, { unique: true });
BizRequestSchema.index({ ownerKind: 1, ownerId: 1, status: 1, createdAt: -1 });
BizRequestSchema.index({ ownerKind: 1, ownerId: 1, chain: 1, status: 1 });
// one open item per source document (a plan, a return, a workflow step)
BizRequestSchema.index({ plan: 1, status: 1 }, { sparse: true });
BizRequestSchema.index({ returnDoc: 1 }, { unique: true, sparse: true });
BizRequestSchema.index({ run: 1, step: 1, status: 1 }, { sparse: true });

const BizRequest = mongoose.model("BizRequest", BizRequestSchema);
export default BizRequest;
