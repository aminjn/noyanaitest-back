import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Noyan Business (2026-10, docs/business-suite.md on the frontend): every
// provider (and the platform itself) keeps its own books. The owner of a
// ledger is a provider org or "platform"; ownerId is the org's _id (the
// platform has none).
export const bizOwnerKinds = [
  "doctor",
  "clinic",
  "hospital",
  "pharmacy",
  "paraClinic",
  "insurance",
  "platform",
] as const;
export type BizOwnerKind = (typeof bizOwnerKinds)[number];

export const bizAccountTypes = ["asset", "liability", "equity", "income", "expense"] as const;
export type BizAccountType = (typeof bizAccountTypes)[number];

// group (گروه) > total (کل) > detail (معین); only detail accounts take
// voucher lines
export const bizAccountLevels = ["group", "total", "detail"] as const;

export interface IBizAccount extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  code: string;
  name: string;
  type: BizAccountType;
  level: (typeof bizAccountLevels)[number];
  parentCode?: string;
  // the system role automatic vouchers post to ("noyanWallet", "visitIncome",
  // ...); a system account can be renamed but not deleted
  role?: string;
  createdAt: Date;
}

const BizAccountSchema = new mongoose.Schema<IBizAccount, Model<IBizAccount>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    code: { type: String, required: true, trim: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: bizAccountTypes, required: true },
    level: { type: String, enum: bizAccountLevels, required: true },
    parentCode: { type: String },
    role: { type: String },
  },
  { timestamps: true },
);

BizAccountSchema.index({ ownerKind: 1, ownerId: 1, code: 1 }, { unique: true });
BizAccountSchema.index(
  { ownerKind: 1, ownerId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: { $type: "string" } } },
);

const BizAccount = mongoose.model("BizAccount", BizAccountSchema);

export default BizAccount;
