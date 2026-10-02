import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One stock movement (2026-10): the kardex row. qty is signed (in +, out -);
// value is qty x cost. A sale and a use take their cost from the batches
// they consumed; what no batch covered is a shortage, valued at the item's
// last cost. ref is unique per owner, so an event is never moved twice.
export const bizMoveKinds = [
  "opening",
  "purchase",
  "sale",
  "use",
  "adjustIn",
  "adjustOut",
  "purchaseReturn",
  "saleReturn",
] as const;
export type BizMoveKind = (typeof bizMoveKinds)[number];

export interface IBizStockMove extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  kind: BizMoveKind;
  qty: number;
  unitCost: number;
  value: number;
  shortage?: number;
  lots: { lot: mongoose.Types.ObjectId; qty: number }[];
  ref?: string;
  note?: string;
  date: Date;
  createdBy?: IUser;
}

const BizStockMoveSchema = new mongoose.Schema<IBizStockMove, Model<IBizStockMove>>({
  ownerKind: { type: String, enum: bizOwnerKinds, required: true },
  ownerId: { type: mongoose.Schema.ObjectId, required: true },
  item: { type: mongoose.Schema.ObjectId, ref: "BizItem", required: true },
  kind: { type: String, enum: bizMoveKinds, required: true },
  qty: { type: Number, required: true },
  unitCost: { type: Number, default: 0 },
  value: { type: Number, default: 0 },
  shortage: { type: Number },
  lots: {
    type: [{ _id: false, lot: { type: mongoose.Schema.ObjectId, ref: "BizStockLot" }, qty: Number }],
    default: [],
  },
  ref: { type: String },
  note: { type: String, maxlength: 300 },
  date: { type: Date, default: () => new Date() },
  createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
});

BizStockMoveSchema.index({ ownerKind: 1, ownerId: 1, item: 1, date: -1 });
BizStockMoveSchema.index(
  { ownerKind: 1, ownerId: 1, ref: 1 },
  { unique: true, partialFilterExpression: { ref: { $type: "string" } } },
);

const BizStockMove = mongoose.model("BizStockMove", BizStockMoveSchema);
export default BizStockMove;
