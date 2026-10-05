import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A purchase from a supplier (2026-10, Lib/business/purchase.ts):
//   draft    - being written, editable
//   received - the goods came in: batches in stock, the payable in the books
//   cancelled - a draft dropped, or a receipt fully undone (only while none
//              of its batches has been used)
// Payments are recorded against a received purchase until it is settled.
export const bizPurchaseStatuses = ["draft", "received", "cancelled"] as const;

export interface IBizPurchaseLine {
  item: mongoose.Types.ObjectId;
  qty: number;
  unitCost: number;
  lotNo?: string;
  expiry?: Date;
}

export interface IBizPurchase extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  supplier: mongoose.Types.ObjectId;
  invoiceNo?: string;
  date: Date;
  status: (typeof bizPurchaseStatuses)[number];
  lines: IBizPurchaseLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paid: number;
  // (2026-10) a payment voided keeps its row: its voucher is reversed and
  // it no longer counts in paid
  payments: {
    _id?: mongoose.Types.ObjectId;
    amount: number;
    via: mongoose.Types.ObjectId;
    date: Date;
    note?: string;
    voidedAt?: Date;
    voidReason?: string;
  }[];
  note?: string;
  receivedAt?: Date;
  createdBy?: IUser;
}

const BizPurchaseSchema = new mongoose.Schema<IBizPurchase, Model<IBizPurchase>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    supplier: { type: mongoose.Schema.ObjectId, ref: "BizSupplier", required: true },
    invoiceNo: { type: String, trim: true, maxlength: 60 },
    date: { type: Date, default: () => new Date() },
    status: { type: String, enum: bizPurchaseStatuses, default: "draft" },
    lines: {
      type: [
        {
          _id: false,
          item: { type: mongoose.Schema.ObjectId, ref: "BizItem", required: true },
          qty: { type: Number, required: true, min: 0 },
          unitCost: { type: Number, required: true, min: 0 },
          lotNo: { type: String, trim: true, maxlength: 60 },
          expiry: { type: Date },
        },
      ],
      default: [],
    },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    payments: {
      type: [
        {
          amount: { type: Number, required: true, min: 0 },
          via: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
          date: { type: Date, default: () => new Date() },
          note: { type: String, maxlength: 300 },
          voidedAt: { type: Date },
          voidReason: { type: String, maxlength: 500 },
        },
      ],
      default: [],
    },
    note: { type: String, maxlength: 500 },
    receivedAt: { type: Date },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizPurchaseSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizPurchaseSchema.index({ ownerKind: 1, ownerId: 1, supplier: 1, status: 1 });

const BizPurchase = mongoose.model("BizPurchase", BizPurchaseSchema);
export default BizPurchase;
