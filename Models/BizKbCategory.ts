import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A category of the staff knowledge base (2026-10, nexxacrm's kbGroup):
// made on the knowledge page or inline from an article's form. Deleting
// one leaves its articles uncategorised.
export interface IBizKbCategory extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  createdAt: Date;
}

const BizKbCategorySchema = new mongoose.Schema<IBizKbCategory, Model<IBizKbCategory>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { timestamps: true },
);

BizKbCategorySchema.index({ ownerKind: 1, ownerId: 1, name: 1 }, { unique: true });

const BizKbCategory = mongoose.model("BizKbCategory", BizKbCategorySchema);
export default BizKbCategory;
