import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The sales side of one CRM contact (2026-10, Lib/business/crmSales.ts):
// what Nexxa keeps on the Contact itself - national id, custom fields, the
// credit limit (credit-limit.ts), the responsible staff member - kept apart
// from BizContact, which the visit and order sync owns. mergedInto marks a
// duplicate archived into another patient (it stays because the sync
// would otherwise bring it back).
export interface IBizContactExt extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  nationalId?: string;
  email?: string;
  customFields?: Record<string, string>;
  creditLimit: number;
  freeCredit: boolean;
  assignee?: mongoose.Types.ObjectId;
  mergedInto?: mongoose.Types.ObjectId;
  mergedAt?: Date;
  createdAt: Date;
}

const BizContactExtSchema = new mongoose.Schema<IBizContactExt, Model<IBizContactExt>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    nationalId: { type: String, trim: true, maxlength: 10 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    customFields: { type: mongoose.Schema.Types.Mixed, default: undefined },
    creditLimit: { type: Number, default: 0, min: 0 },
    freeCredit: { type: Boolean, default: false },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    mergedInto: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    mergedAt: Date,
  },
  { timestamps: true },
);

BizContactExtSchema.index({ contact: 1 }, { unique: true });
BizContactExtSchema.index({ ownerKind: 1, ownerId: 1, nationalId: 1 });

const BizContactExt = mongoose.model("BizContactExt", BizContactExtSchema);
export default BizContactExt;
