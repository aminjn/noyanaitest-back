import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One patient or customer of one owner (2026-10, Lib/business/crm.ts): built
// from the owner's own visits and orders (so the list is the people who
// already came - the consent base for an SMS campaign), or added by hand.
// The visit and order figures are kept in step by the sync; tags, the note
// and the opt-out are the owner's.
export const bizContactSources = ["visit", "order", "manual"] as const;

export interface IBizContact extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  name: string;
  // 09xxxxxxxxx
  phone: string;
  gender?: "male" | "female";
  birthYear?: number;
  city?: string;
  source: (typeof bizContactSources)[number];
  tags: string[];
  note?: string;
  visits: number;
  orders: number;
  spent: number;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  // no campaign SMS from this owner (the contact's own wish or the owner's)
  smsOptOut: boolean;
  optOutAt?: Date;
  // short code in the opt-out link of a campaign SMS
  optCode: string;
  isActive: boolean;
  createdAt: Date;
}

const BizContactSchema = new mongoose.Schema<IBizContact, Model<IBizContact>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    name: { type: String, trim: true, maxlength: 200, default: "" },
    phone: { type: String, required: true, match: /^09\d{9}$/ },
    gender: { type: String, enum: ["male", "female"] },
    birthYear: { type: Number, min: 1300, max: 2100 },
    city: { type: String, trim: true, maxlength: 100 },
    source: { type: String, enum: bizContactSources, default: "manual" },
    tags: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    note: { type: String, trim: true, maxlength: 1000 },
    visits: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    firstSeenAt: Date,
    lastSeenAt: Date,
    smsOptOut: { type: Boolean, default: false },
    optOutAt: Date,
    optCode: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BizContactSchema.index({ ownerKind: 1, ownerId: 1, phone: 1 }, { unique: true });
BizContactSchema.index({ ownerKind: 1, ownerId: 1, lastSeenAt: -1 });
BizContactSchema.index({ ownerKind: 1, ownerId: 1, tags: 1 });

const BizContact = mongoose.model("BizContact", BizContactSchema);
export default BizContact;
