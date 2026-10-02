import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One received batch of an item (2026-10): its own cost (a FIFO layer) and
// its own expiry (FEFO - the batch that expires first leaves first, the
// rule for drugs and lab kits; nexxacrm lib/lot-core.ts and fifo-core.ts).
// qty is what is left of it.
export interface IBizStockLot extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  item: mongoose.Types.ObjectId;
  lotNo?: string;
  expiry?: Date;
  qty: number;
  received: number;
  unitCost: number;
  receivedAt: Date;
  // where it came from ("po:<id>", "opening:<move>")
  ref?: string;
}

const BizStockLotSchema = new mongoose.Schema<IBizStockLot, Model<IBizStockLot>>({
  ownerKind: { type: String, enum: bizOwnerKinds, required: true },
  ownerId: { type: mongoose.Schema.ObjectId, required: true },
  item: { type: mongoose.Schema.ObjectId, ref: "BizItem", required: true },
  lotNo: { type: String, trim: true, maxlength: 60 },
  expiry: { type: Date },
  qty: { type: Number, required: true, min: 0 },
  received: { type: Number, required: true, min: 0 },
  unitCost: { type: Number, required: true, min: 0 },
  receivedAt: { type: Date, default: () => new Date() },
  ref: { type: String },
});

BizStockLotSchema.index({ ownerKind: 1, ownerId: 1, item: 1, qty: 1 });
BizStockLotSchema.index({ ownerKind: 1, ownerId: 1, expiry: 1 }, { partialFilterExpression: { qty: { $gt: 0 } } });

const BizStockLot = mongoose.model("BizStockLot", BizStockLotSchema);
export default BizStockLot;
