import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A تفصیلی (floating detail account, Nexxa's Tafsili) of one owner's books
// (2026-10, Lib/business/parties.ts): a patient, a supplier, an insurer, a
// person on the team, a doctor, a bank/till, a project or anything else the
// owner keeps a separate ledger for. It is not an account: a voucher line
// carries it beside its معین, so «بدهکاران» keeps one balance per patient.
// Codes run in a range per kind, the way Hamkaran and Sepidar keep the
// register (patients 10001.., suppliers 15001.., banks 20001..).
export const bizPartyKinds = ["patient", "supplier", "insurer", "person", "doctor", "bank", "project", "custom"] as const;
export type BizPartyKind = (typeof bizPartyKinds)[number];

export interface IBizParty extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  code: string;
  kind: BizPartyKind;
  name: string;
  phone?: string;
  nationalId?: string;
  economicCode?: string;
  postalCode?: string;
  address?: string;
  note?: string;
  isActive: boolean;
  // what it stands for elsewhere (a supplier, an employee, a money account,
  // a CRM contact) and the key an automatic voucher finds it by
  ref?: { type: string; id: mongoose.Types.ObjectId };
  key?: string;
  // the opening balance typed on it was booked (contact-opening)
  openingPosted?: boolean;
  createdAt: Date;
}

const BizPartySchema = new mongoose.Schema<IBizParty, Model<IBizParty>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    code: { type: String, required: true, trim: true, maxlength: 20 },
    kind: { type: String, enum: bizPartyKinds, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    nationalId: { type: String, trim: true, maxlength: 20 },
    economicCode: { type: String, trim: true, maxlength: 20 },
    postalCode: { type: String, trim: true, maxlength: 12 },
    address: { type: String, trim: true, maxlength: 400 },
    note: { type: String, trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
    ref: { type: new mongoose.Schema({ type: String, id: mongoose.Schema.ObjectId }, { _id: false }), default: undefined },
    key: { type: String, maxlength: 300 },
    openingPosted: { type: Boolean },
  },
  { timestamps: true },
);

BizPartySchema.index({ ownerKind: 1, ownerId: 1, code: 1 }, { unique: true });
BizPartySchema.index({ ownerKind: 1, ownerId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });
BizPartySchema.index({ ownerKind: 1, ownerId: 1, kind: 1, name: 1 });

const BizParty = mongoose.model("BizParty", BizPartySchema);
export default BizParty;
