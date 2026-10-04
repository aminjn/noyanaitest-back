import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A staff article of one owner (2026-10, nexxacrm's kbArticle): the
// centre's own procedures - admission, insurance paperwork, sterilisation,
// dispensing. Drafts are seen only by whoever may write the CRM; the team
// reads the published ones.
export interface IBizKbArticle extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  title: string;
  content: string;
  category?: mongoose.Types.ObjectId;
  published: boolean;
  views: number;
  createdBy?: IUser;
  updatedBy?: IUser;
  createdAt: Date;
  updatedAt: Date;
}

const BizKbArticleSchema = new mongoose.Schema<IBizKbArticle, Model<IBizKbArticle>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    content: { type: String, required: true, maxlength: 50_000 },
    category: { type: mongoose.Schema.ObjectId, ref: "BizKbCategory" },
    published: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizKbArticleSchema.index({ ownerKind: 1, ownerId: 1, updatedAt: -1 });
BizKbArticleSchema.index({ ownerKind: 1, ownerId: 1, category: 1 });

const BizKbArticle = mongoose.model("BizKbArticle", BizKbArticleSchema);
export default BizKbArticle;
