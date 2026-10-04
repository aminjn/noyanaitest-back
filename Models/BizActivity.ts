import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A note, a call or a follow-up on one contact (2026-10, Lib/business/
// crm.ts) - nexxacrm's Activity. A follow-up has a due date ("call in six
// months for the check-up") and is done once; visits and orders are not
// copied here, the contact's timeline reads them from their own records.
export const bizActivityKinds = ["note", "call", "followUp"] as const;

export interface IBizActivity extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  kind: (typeof bizActivityKinds)[number];
  text: string;
  dueAt?: Date;
  doneAt?: Date;
  // a follow-up's owner: the panel owner or one of its secretaries; told
  // in-app when it falls due (remindedAt, once)
  assignee?: mongoose.Types.ObjectId;
  remindedAt?: Date;
  createdBy?: IUser;
  createdAt: Date;
}

const BizActivitySchema = new mongoose.Schema<IBizActivity, Model<IBizActivity>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    kind: { type: String, enum: bizActivityKinds, required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    dueAt: Date,
    doneAt: Date,
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    remindedAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizActivitySchema.index({ ownerKind: 1, ownerId: 1, contact: 1, createdAt: -1 });
BizActivitySchema.index({ ownerKind: 1, ownerId: 1, kind: 1, doneAt: 1, dueAt: 1 });
BizActivitySchema.index({ kind: 1, doneAt: 1, remindedAt: 1, dueAt: 1 });

const BizActivity = mongoose.model("BizActivity", BizActivitySchema);
export default BizActivity;
