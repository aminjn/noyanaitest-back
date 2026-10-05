import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Patient-consented linking of a centre's CRM contact to a Noyan account
// (2026-10, Lib/business/crmService/link.ts). A centre's hand-added,
// imported or web-form contact whose mobile equals a user's verified login
// phone becomes an offer to that user; nothing is linked until the patient
// says so. One row per (contact, user):
//   pending   - waiting for the patient (snoozedUntil: they said «بعداً»)
//   linked    - the patient confirmed; BizContact.user is set
//   declined  - «این من نیستم»: never offered again, the centre sees a
//               possible wrong number
//   unlinked  - the patient took the link back; offered again only if they
//               link it again themselves
//   withdrawn - no longer valid (the user's phone changed, the contact was
//               removed or linked to someone else)
// Every change is also written to BizConsentLog (append-only).
export const bizLinkStatuses = ["pending", "linked", "declined", "unlinked", "withdrawn"] as const;
export type BizLinkStatus = (typeof bizLinkStatuses)[number];
// how the centre came to have the contact
export const bizLinkSources = ["manual", "csv", "webform", "visit"] as const;
export type BizLinkSource = (typeof bizLinkSources)[number];

export interface IBizLinkOffer extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  // the normalized mobile (09xxxxxxxxx) the match was made on
  phone: string;
  source: BizLinkSource;
  status: BizLinkStatus;
  offeredAt: Date;
  snoozedUntil?: Date;
  linkedAt?: Date;
  declinedAt?: Date;
  unlinkedAt?: Date;
  withdrawnAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BizLinkOfferSchema = new mongoose.Schema<IBizLinkOffer, Model<IBizLinkOffer>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    phone: { type: String, required: true, match: /^09\d{9}$/ },
    source: { type: String, enum: bizLinkSources, required: true },
    status: { type: String, enum: bizLinkStatuses, default: "pending" },
    offeredAt: { type: Date, default: () => new Date() },
    snoozedUntil: Date,
    linkedAt: Date,
    declinedAt: Date,
    unlinkedAt: Date,
    withdrawnAt: Date,
  },
  { timestamps: true },
);

BizLinkOfferSchema.index({ contact: 1, user: 1 }, { unique: true });
BizLinkOfferSchema.index({ user: 1, status: 1 });
BizLinkOfferSchema.index({ contact: 1, status: 1 });

const BizLinkOffer = mongoose.model("BizLinkOffer", BizLinkOfferSchema);
export default BizLinkOffer;
