import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One patient or customer of one owner (2026-10, Lib/business/crm.ts): built
// from the owner's own visits and orders (so the list is the people who
// already came - the consent base for an SMS campaign), or added by hand.
// The visit and order figures are kept in step by the sync; tags, the note
// and the opt-out are the owner's.
export const bizContactSources = ["visit", "order", "manual", "import"] as const;
// the patient's basic insurer (Tamin, Salamat, armed forces, ...), kept by
// the owner or filled by an import - Noyan's bookings do not carry it
export const bizInsurers = ["tamin", "salamat", "armed", "other", "none"] as const;

export interface IBizContact extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  name: string;
  // 09xxxxxxxxx
  phone: string;
  gender?: "male" | "female";
  birthYear?: number;
  // the day of birth, and its Jalali month*100+day (birthdays this week /
  // this month, the birthday automation)
  birthDate?: Date;
  birthMD?: number;
  city?: string;
  insurer?: (typeof bizInsurers)[number];
  source: (typeof bizContactSources)[number];
  tags: string[];
  note?: string;
  visits: number;
  orders: number;
  spent: number;
  // the patient's own no-shows with this owner, and the last one
  noShows: number;
  lastNoShowAt?: Date;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  // the last visit (not order) and its session type (recall rules)
  lastVisitAt?: Date;
  lastSessionType?: string;
  // the prior relationship a campaign SMS rests on: a visit or order on
  // Noyan, or the owner's word for a hand-added / imported patient
  consentAt?: Date;
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
    birthDate: Date,
    birthMD: { type: Number, min: 101, max: 1231 },
    city: { type: String, trim: true, maxlength: 100 },
    insurer: { type: String, enum: bizInsurers },
    source: { type: String, enum: bizContactSources, default: "manual" },
    tags: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    note: { type: String, trim: true, maxlength: 1000 },
    visits: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    noShows: { type: Number, default: 0 },
    lastNoShowAt: Date,
    firstSeenAt: Date,
    lastSeenAt: Date,
    lastVisitAt: Date,
    lastSessionType: { type: String, maxlength: 40 },
    consentAt: Date,
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
BizContactSchema.index({ ownerKind: 1, ownerId: 1, birthMD: 1 });
BizContactSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });

const BizContact = mongoose.model("BizContact", BizContactSchema);
export default BizContact;
