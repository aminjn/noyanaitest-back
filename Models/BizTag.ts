import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A contact tag one owner created inline (2026-10, the CRM tag picker): the
// contacts keep their tags as names, this only remembers tags no contact
// carries yet, so a new tag can be created from the field that uses it.
export interface IBizTag extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
}

const BizTagSchema = new mongoose.Schema<IBizTag, Model<IBizTag>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
  },
  { timestamps: true },
);

BizTagSchema.index({ ownerKind: 1, ownerId: 1, name: 1 }, { unique: true });

const BizTag = mongoose.model("BizTag", BizTagSchema);
export default BizTag;
