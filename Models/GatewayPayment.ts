import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IOrder } from "./Order";
import { ITransaction } from "./Transaction";

// One row per online-gateway payment attempt (2026-09, SEP/Saman - see
// Lib/sepClient.ts and Services/paymentService.ts). Every attempt ends as a
// wallet credit on success; what happens next depends on `purpose`:
//
//   walletCharge -> nothing more, the money stays in the wallet (top-up)
//   order        -> the credited amount is immediately debited again to pay
//                   the linked pending Order (cart checkout "sep" method)
//
// Routing every success through the wallet keeps the Transaction ledger
// (GET /user/transaction) summing to the wallet balance, and means a
// payment whose order can no longer be completed never loses money - it
// simply stays as wallet balance.
export const paymentGateways = ["sep"] as const;
export type PaymentGateway = (typeof paymentGateways)[number];

export const gatewayPaymentPurposes = ["walletCharge", "order"] as const;
export type GatewayPaymentPurpose = (typeof gatewayPaymentPurposes)[number];

// created     -> token issued, shopper sent to the gateway
// verifying   -> callback claimed this row (exactly one callback can), the
//                verify call is in flight
// paid        -> verified with SEP and the wallet was credited
// failed      -> cancelled / failed / expired / not verifiable - SEP
//                auto-refunds any unverified card debit within ~30 minutes
// reversed    -> verified but then refunded to the card via Reverse (e.g.
//                amount mismatch)
// needsReview -> verified but crediting failed AND the reverse failed too -
//                money was taken, an admin must resolve it by hand
export const gatewayPaymentStatuses = [
  "created",
  "verifying",
  "paid",
  "failed",
  "reversed",
  "needsReview",
] as const;
export type GatewayPaymentStatus = (typeof gatewayPaymentStatuses)[number];

export interface IGatewayPayment extends MongoDoc {
  gateway: PaymentGateway;
  purpose: GatewayPaymentPurpose;
  user: IUser;
  // in app units (Toman) - what gets credited to the wallet
  amount: number;
  // in gateway units (Rial) - what was sent to / must be confirmed by SEP
  gatewayAmount: number;
  order?: IOrder;
  // frontend path to offer as "continue" on the result page (e.g. the
  // booking/license checkout the shopper topped up from) - always a
  // same-site path, validated on input
  returnPath?: string;
  status: GatewayPaymentStatus;
  // our purchase id sent as ResNum - the row's own _id as a string, stored
  // separately so the callback lookup is an indexed exact match
  resNum: string;
  token?: string;
  // SEP's digital receipt - unique across ALL payments so the same receipt
  // can never be honored twice (the doc's "Double Spending" requirement)
  refNum?: string;
  rrn?: string;
  traceNo?: string;
  maskedPan?: string;
  state?: string;
  verifyResultCode?: number;
  verifyResultDescription?: string;
  failureReason?: string;
  // the wallet credit this payment produced
  transaction?: ITransaction;
  // when the current "verifying" attempt started - lets the recovery sweep
  // (Services/paymentService.ts runGatewayPaymentSweep) re-claim a row whose
  // verify never finished (e.g. the server restarted mid-request)
  claimedAt?: Date;
  createdAt: Date;
  verifiedAt?: Date;
}

const GatewayPaymentSchema = new mongoose.Schema<
  IGatewayPayment,
  Model<IGatewayPayment>
>({
  gateway: { type: String, enum: paymentGateways, required: true },
  purpose: { type: String, enum: gatewayPaymentPurposes, required: true },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true, min: 1 },
  gatewayAmount: { type: Number, required: true, min: 1 },
  order: { type: mongoose.Schema.ObjectId, ref: "Order" },
  returnPath: { type: String },
  status: {
    type: String,
    enum: gatewayPaymentStatuses,
    required: true,
    default: "created",
  },
  resNum: { type: String, required: true, unique: true },
  token: { type: String },
  refNum: { type: String, unique: true, sparse: true },
  rrn: { type: String },
  traceNo: { type: String },
  maskedPan: { type: String },
  state: { type: String },
  verifyResultCode: { type: Number },
  verifyResultDescription: { type: String },
  failureReason: { type: String },
  transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  claimedAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
  verifiedAt: { type: Date },
});

GatewayPaymentSchema.index({ user: 1, createdAt: -1 });
GatewayPaymentSchema.index({ status: 1, createdAt: 1 });

const GatewayPayment = mongoose.model("GatewayPayment", GatewayPaymentSchema);

export default GatewayPayment;
