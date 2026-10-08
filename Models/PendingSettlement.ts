import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// A settlement that failed after the state change it follows (2026-10,
// Services/settlementRetryService.ts). The state moved - a line fulfilled or
// cancelled, a Tipax parcel confirmed delivered - but the money step after
// it threw (a database hiccup, a lookup that timed out): instead of being
// only logged, it is recorded here and retried with backoff by a sweep.
// Every retry goes through the same idempotent settlement (one Transaction
// per order line / shipment), so a retry never pays or refunds twice.
//
//   orderLine          -> settleOrderLine for one line of an order
//   shipmentDelivered  -> the payout of a delivered Tipax parcel's lines
//
// Open while `open` is set (cleared, with `doneAt`, once it settled);
// admins subscribed to «تسویه‌ی ناموفق سفارش» are alerted once
// (`alertedAt`) after ALERT_AFTER failed attempts.
export const pendingSettlementKinds = ["orderLine", "shipmentDelivered"] as const;
export type PendingSettlementKind = (typeof pendingSettlementKinds)[number];

export interface IPendingSettlement extends MongoDoc {
  kind: PendingSettlementKind;
  order: mongoose.Types.ObjectId;
  // orderLine: the line's model and its catalog item
  model?: string;
  itemId?: string;
  // shipmentDelivered: the parcel
  shipment?: mongoose.Types.ObjectId;
  // the settlement's own arguments, replayed on retry
  sellerUser?: mongoose.Types.ObjectId;
  org?: {
    pharmacy?: mongoose.Types.ObjectId;
    doctor?: mongoose.Types.ObjectId;
    paraClinic?: mongoose.Types.ObjectId;
  };
  autoCancel?: string;
  onDelivery?: boolean;
  deliveredBy?: string;
  // true while it waits to be settled (a partial unique index needs a
  // positive match: MongoDB has no `$exists: false` in one)
  open?: boolean;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  alertedAt?: Date;
  doneAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PendingSettlementSchema = new mongoose.Schema<IPendingSettlement, Model<IPendingSettlement>>(
  {
    kind: { type: String, enum: pendingSettlementKinds, required: true },
    order: { type: mongoose.Schema.ObjectId, ref: "Order", required: true },
    model: { type: String },
    itemId: { type: String },
    shipment: { type: mongoose.Schema.ObjectId },
    sellerUser: { type: mongoose.Schema.ObjectId, ref: "User" },
    org: {
      type: new mongoose.Schema(
        {
          pharmacy: { type: mongoose.Schema.ObjectId, ref: "Pharmacy" },
          doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
          paraClinic: { type: mongoose.Schema.ObjectId, ref: "ParaClinic" },
        },
        { _id: false },
      ),
      default: undefined,
    },
    autoCancel: { type: String },
    onDelivery: { type: Boolean },
    deliveredBy: { type: String },
    open: { type: Boolean },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true },
    lastError: { type: String, maxlength: 1000 },
    alertedAt: { type: Date },
    doneAt: { type: Date },
  },
  { timestamps: true },
);

// one open record per line / parcel: a second failure of the same
// settlement updates it instead of queueing it twice
PendingSettlementSchema.index(
  { kind: 1, order: 1, model: 1, itemId: 1, shipment: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
PendingSettlementSchema.index({ nextAttemptAt: 1 }, { partialFilterExpression: { open: true } });

const PendingSettlement = mongoose.model("PendingSettlement", PendingSettlementSchema);

export default PendingSettlement;
