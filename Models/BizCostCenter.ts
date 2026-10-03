import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A cost centre (مرکز هزینه) of one owner's books (2026-10, docs/business-
// suite.md phase 6): a ward, a unit, a branch or a doctor's room. A voucher
// typed by hand can name one; the cost-centre report sums the income and
// expense of each. Created inline from the voucher form that uses it.
export interface IBizCostCenter extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
}

const BizCostCenterSchema = new mongoose.Schema<IBizCostCenter, Model<IBizCostCenter>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BizCostCenterSchema.index({ ownerKind: 1, ownerId: 1, name: 1 }, { unique: true });

const BizCostCenter = mongoose.model("BizCostCenter", BizCostCenterSchema);

export default BizCostCenter;
