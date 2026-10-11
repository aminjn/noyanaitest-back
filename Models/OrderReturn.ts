import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Returns of delivered cart order lines (2026-10, owner decision - the
// Digikala «مرجوعی» flow, Snapp Pharmacy / Amazon / Halodoc). One document per
// request: a buyer's return of some units of one pharmacy line, or a
// refund a lab or support gives on a line whose service was done (a test
// performed is never "returned", it is refunded). Services/
// orderReturnService.ts owns every transition; each is one conditional
// update on `status`, so two actors at the same moment change it once:
//
//   requested --seller--> approved | rejected
//   requested --buyer--> cancelled
//   rejected --buyer--> escalated            (the /requests queue)
//   escalated --admin--> approved | declined (reject with a reason)
//   declined --admin reopen--> escalated
//   approved --buyer (Tipax waybill) / seller (Tapsi courier)--> shipped
//   approved --buyer--> cancelled            (not sent yet)
//   approved | shipped --seller confirms receipt (or support)--> refunded
//   a lab's / support's refund: created "refunded" (no goods move)
//
// The money of "refunded" (Services/orderReturnService.ts settleReturn) -
// the seller's part always out of its earnings still held, never a debt -
// is posted once and only once: every step is keyed (Transaction.returnKey,
// the line's returnsApplied, the books' refs), so a retry finishes what is
// missing and never pays twice.

export const orderReturnReasons = ["wrongItem", "damaged", "expired", "notAsDescribed", "changedMind"] as const;
export type OrderReturnReason = (typeof orderReturnReasons)[number];

// the seller's error (free return shipping, any item); "changedMind" is the
// buyer's own choice (non-prescription, unopened, returnable category only)
export const sellerFaultReasons: readonly OrderReturnReason[] = ["wrongItem", "damaged", "expired", "notAsDescribed"];

// a lab's / support's refund on a line whose service was done
export const orderRefundReasons = ["serviceIssue", "sellerError", "goodwill", "other"] as const;
export type OrderRefundReason = (typeof orderRefundReasons)[number];

export const orderReturnStatuses = [
  "requested",
  "approved",
  "rejected",
  "escalated",
  "declined",
  "shipped",
  "refunded",
  "cancelled",
] as const;
export type OrderReturnStatus = (typeof orderReturnStatuses)[number];

// still holding units of the line (returnHeldQty on the order line)
export const openReturnStatuses: OrderReturnStatus[] = ["requested", "approved", "rejected", "escalated", "shipped"];

export const orderReturnKinds = ["return", "refund"] as const;
export type OrderReturnKind = (typeof orderReturnKinds)[number];

export const returnConditions = ["resellable", "damaged"] as const;
export type ReturnCondition = (typeof returnConditions)[number];

export type ReturnLineModel = "products" | "productPackages" | "tests";

// The returned units' share of the line (toman), taken when the money is
// settled, before the discount re-check: what the buyer paid for them
// (VAT included) and the seller's earning on them.
export interface IOrderReturnShare {
  lineTotal: number;
  club: number;
  promo: number;
  insurer: number;
  tax: number;
  // what the buyer paid for the units (sale - insurer - platform promo + VAT)
  paid: number;
  // the seller's earning rows on them (Transaction: earning + its
  // discount adjustments): what is reversed
  sellerGross: number;
  sellerCommission: number;
  sellerTax: number;
  sellerAmount: number;
  subsidy: number;
  // the earning row (for the books and the Moadian correction)
  earning?: mongoose.Types.ObjectId;
}

export interface IOrderReturn extends MongoDoc {
  order: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  sellerKind: "pharmacy" | "paraClinic";
  seller: mongoose.Types.ObjectId;
  model: ReturnLineModel;
  line: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  qty: number;
  kind: OrderReturnKind;
  initiatedBy: "buyer" | "seller" | "admin";
  reason: OrderReturnReason | OrderRefundReason;
  note?: string;
  photos: mongoose.Types.ObjectId[];
  // "changedMind": the buyer confirmed the pack is unopened
  unopened?: boolean;
  sellerFault: boolean;
  status: OrderReturnStatus;
  rejectReason?: string;
  // the buyer took the seller's "no" to support (Models/ReturnEscalation.ts)
  escalation?: mongoose.Types.ObjectId;
  // how the goods come back (the order's own shipment method), who pays it
  shipping?: {
    method: "tapsi" | "tipax" | "inPerson";
    // the Tapsi courier fee a buyer-fault return pays (kept off the refund,
    // paid to the pharmacy that sends the courier); Tipax is paid at the
    // counter (by the pharmacy on receipt when it is the seller's error)
    fee: number;
    paidBy: "seller" | "buyer";
    trackingCode?: string;
    shippedAt?: Date;
  };
  receivedAt?: Date;
  condition?: ReturnCondition;
  share?: IOrderReturnShare;
  // the discount the rest of the order no longer earns (Lib/
  // orderPromoRecheck.ts): kept back from the refund; its plan, written
  // once before it is applied to the order
  promoPlan?: {
    clawback: number;
    changes: { model: string; lineId: string; reducedBy: number; taxDelta: number }[];
    releaseCode: boolean;
  };
  money?: {
    refund: number;
    shippingDeduction: number;
    promoClawback: number;
    sellerReversal: number;
    // the parcel's delivery fee given back (a seller-error return that left
    // the buyer nothing of it)
    deliveryRefund?: number;
  };
  // the steps of the settlement, each done once
  steps?: {
    applied?: Date;
    promo?: Date;
    seller?: Date;
    buyer?: Date;
    shipping?: Date;
    delivery?: Date;
    insurer?: Date;
    stock?: Date;
    club?: Date;
  };
  refundedAt?: Date;
  history: { action: string; by?: mongoose.Types.ObjectId; byKind: "buyer" | "seller" | "admin" | "system"; note?: string; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const OrderReturnSchema = new mongoose.Schema<IOrderReturn, Model<IOrderReturn>>(
  {
    order: { type: mongoose.Schema.ObjectId, ref: "Order", required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    sellerKind: { type: String, enum: ["pharmacy", "paraClinic"], required: true },
    seller: { type: mongoose.Schema.ObjectId, required: true },
    model: { type: String, enum: ["products", "productPackages", "tests"], required: true },
    line: { type: mongoose.Schema.ObjectId, required: true },
    item: { type: mongoose.Schema.ObjectId, required: true },
    qty: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: orderReturnKinds, required: true },
    initiatedBy: { type: String, enum: ["buyer", "seller", "admin"], required: true },
    reason: { type: String, enum: [...orderReturnReasons, ...orderRefundReasons], required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    photos: { type: [{ type: mongoose.Schema.ObjectId, ref: "UserFile" }], default: [] },
    unopened: { type: Boolean },
    sellerFault: { type: Boolean, default: false },
    status: { type: String, enum: orderReturnStatuses, required: true },
    rejectReason: { type: String, trim: true, maxlength: 500 },
    escalation: { type: mongoose.Schema.ObjectId, ref: "ReturnEscalation" },
    shipping: {
      type: new mongoose.Schema(
        {
          method: { type: String, enum: ["tapsi", "tipax", "inPerson"], required: true },
          fee: { type: Number, min: 0, default: 0 },
          paidBy: { type: String, enum: ["seller", "buyer"], required: true },
          trackingCode: { type: String, trim: true, maxlength: 200 },
          shippedAt: { type: Date },
        },
        { _id: false },
      ),
      default: undefined,
    },
    receivedAt: { type: Date },
    condition: { type: String, enum: returnConditions },
    share: {
      type: new mongoose.Schema(
        {
          lineTotal: Number,
          club: Number,
          promo: Number,
          insurer: Number,
          tax: Number,
          paid: Number,
          sellerGross: Number,
          sellerCommission: Number,
          sellerTax: Number,
          sellerAmount: Number,
          subsidy: Number,
          earning: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
        },
        { _id: false },
      ),
      default: undefined,
    },
    promoPlan: {
      type: new mongoose.Schema(
        {
          clawback: { type: Number, min: 0, default: 0 },
          changes: {
            type: [new mongoose.Schema({ model: String, lineId: String, reducedBy: Number, taxDelta: Number }, { _id: false })],
            default: [],
          },
          releaseCode: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: undefined,
    },
    money: {
      type: new mongoose.Schema(
        { refund: Number, shippingDeduction: Number, promoClawback: Number, sellerReversal: Number, deliveryRefund: Number },
        { _id: false },
      ),
      default: undefined,
    },
    steps: {
      type: new mongoose.Schema(
        {
          applied: Date,
          promo: Date,
          seller: Date,
          buyer: Date,
          shipping: Date,
          delivery: Date,
          insurer: Date,
          stock: Date,
          club: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
    refundedAt: { type: Date },
    history: {
      type: [
        new mongoose.Schema(
          {
            action: { type: String, required: true },
            by: { type: mongoose.Schema.ObjectId, ref: "User" },
            byKind: { type: String, enum: ["buyer", "seller", "admin", "system"], required: true },
            note: { type: String, trim: true, maxlength: 1000 },
            at: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

OrderReturnSchema.index({ order: 1, createdAt: 1 });
OrderReturnSchema.index({ sellerKind: 1, seller: 1, status: 1, createdAt: -1 });
OrderReturnSchema.index({ user: 1, createdAt: -1 });
// the sweeps (Services/orderReturnService.ts runReturnSweep)
OrderReturnSchema.index({ status: 1, updatedAt: 1 });

const OrderReturn = mongoose.model("OrderReturn", OrderReturnSchema);

export default OrderReturn;
