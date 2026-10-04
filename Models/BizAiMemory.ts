import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// What one owner chose for a kind of entry (2026-10, Lib/business/
// financeAi.ts): a vendor or the words of a bank line, and the account and
// cost centre it was booked to. The categoriser reads these (and the
// owner's own past expenses and payments) before it asks the AI, so a
// practice's own habits win over a model's guess.
export interface IBizAiMemory extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  // normalised text: the vendor, or the bank line's description
  key: string;
  account: mongoose.Types.ObjectId;
  center?: mongoose.Types.ObjectId;
  count: number;
  lastAt: Date;
}

const BizAiMemorySchema = new mongoose.Schema<IBizAiMemory, Model<IBizAiMemory>>({
  ownerKind: { type: String, enum: bizOwnerKinds, required: true },
  ownerId: { type: mongoose.Schema.ObjectId, required: true },
  key: { type: String, required: true, maxlength: 200 },
  account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
  center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
  count: { type: Number, default: 1 },
  lastAt: { type: Date, default: () => new Date() },
});

BizAiMemorySchema.index({ ownerKind: 1, ownerId: 1, key: 1, account: 1 }, { unique: true });

const BizAiMemory = mongoose.model("BizAiMemory", BizAiMemorySchema);
export default BizAiMemory;
