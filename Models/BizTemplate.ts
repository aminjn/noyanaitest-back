import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A reusable SMS text of one owner (2026-10, Lib/business/crmSend.ts), with
// variables filled per recipient: {name} {firstName} {org} {link} {review}
// {lastVisit}. Like a campaign, its text is cleared once by the super admin
// (the /requests queue, group "smsTemplate") against the medical
// advertising rules; only an approved template is sent by an automation or
// as a one-off SMS from a contact's page. Editing the text sends it back to
// a draft, which pauses whatever uses it until it is approved again.
//   Draft -> Pending -> Approved | Rejected (-> Pending again)
export const bizTemplateStatuses = ["Draft", "Pending", "Approved", "Rejected"] as const;
export const bizTemplateCategories = ["general", "recall", "thanks", "birthday", "noShow", "winback", "chronic"] as const;

export interface IBizTemplate extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  text: string;
  category: (typeof bizTemplateCategories)[number];
  status: (typeof bizTemplateStatuses)[number];
  rejectReason?: string;
  submittedAt?: Date;
  decidedAt?: Date;
  decidedBy?: IUser;
  createdBy?: IUser;
  createdAt: Date;
}

const BizTemplateSchema = new mongoose.Schema<IBizTemplate, Model<IBizTemplate>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    text: { type: String, required: true, maxlength: 700 },
    category: { type: String, enum: bizTemplateCategories, default: "general" },
    status: { type: String, enum: bizTemplateStatuses, default: "Draft" },
    rejectReason: { type: String, maxlength: 500 },
    submittedAt: Date,
    decidedAt: Date,
    decidedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizTemplateSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });
BizTemplateSchema.index({ status: 1, ownerKind: 1 });

const BizTemplate = mongoose.model("BizTemplate", BizTemplateSchema);
export default BizTemplate;
