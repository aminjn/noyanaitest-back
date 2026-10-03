import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One Jalali year's budget of one owner's books (2026-10, docs/business-
// suite.md phase 6): an annual amount for each income or expense account,
// spread evenly over the twelve months when compared with what happened.
export interface IBizBudget extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  year: number;
  lines: { account: mongoose.Types.ObjectId; code: string; amount: number }[];
}

const BizBudgetSchema = new mongoose.Schema<IBizBudget, Model<IBizBudget>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    year: { type: Number, required: true },
    lines: [
      {
        _id: false,
        account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
        code: { type: String, required: true },
        amount: { type: Number, required: true, min: 0 },
      },
    ],
  },
  { timestamps: true },
);

BizBudgetSchema.index({ ownerKind: 1, ownerId: 1, year: 1 }, { unique: true });

const BizBudget = mongoose.model("BizBudget", BizBudgetSchema);

export default BizBudget;
