import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A checklist of the team (2026-10, nexxacrm's checklistList): a list of
// to-dos, or a template (the WHO surgical safety checklist, a pre-visit
// list) started anew for one patient. Deleting a list keeps its items as
// loose items (nexxacrm's rule).
export interface IBizChecklist extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  color?: string;
  isTemplate: boolean;
  // started from a template for this patient
  contact?: mongoose.Types.ObjectId;
  template?: mongoose.Types.ObjectId;
  sequence: number;
  createdBy?: IUser;
  createdAt: Date;
}

const BizChecklistSchema = new mongoose.Schema<IBizChecklist, Model<IBizChecklist>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    color: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
    isTemplate: { type: Boolean, default: false },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    template: { type: mongoose.Schema.ObjectId, ref: "BizChecklist" },
    sequence: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizChecklistSchema.index({ ownerKind: 1, ownerId: 1, sequence: 1 });

const BizChecklist = mongoose.model("BizChecklist", BizChecklistSchema);
export default BizChecklist;
