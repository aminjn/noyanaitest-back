import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A supplier of one owner (2026-10): a drug distributor (پخش), a lab-kit
// dealer, a medical supplies seller. What is owed to it is the sum of its
// received purchases minus what was paid (BizPurchase).
export interface IBizSupplier extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  phone?: string;
  economicCode?: string;
  address?: string;
  note?: string;
  isActive: boolean;
}

const BizSupplierSchema = new mongoose.Schema<IBizSupplier, Model<IBizSupplier>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    economicCode: { type: String, trim: true, maxlength: 30 },
    address: { type: String, trim: true, maxlength: 500 },
    note: { type: String, trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BizSupplierSchema.index({ ownerKind: 1, ownerId: 1, name: 1 });

const BizSupplier = mongoose.model("BizSupplier", BizSupplierSchema);
export default BizSupplier;
