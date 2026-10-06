import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";
import { BizLinkSource, bizLinkSources } from "./BizLinkOffer";

// The evidence trail of patient-consented record linking (2026-10,
// Lib/business/crmService/link.ts): every offer, link, «این من نیستم»,
// «بعداً», unlink and withdrawal, with who, when, from where (IP, user
// agent) and on which phone. Append-only: there is no update or delete
// route, and the model refuses updates and deletes, so a row can be
// produced as it was written if a patient or a centre complains. Kept
// indefinitely (no TTL).
export const bizConsentActions = ["offered", "linked", "declined", "dismissed-later", "unlinked", "withdrawn"] as const;
export type BizConsentAction = (typeof bizConsentActions)[number];
// who did it: the patient, or Noyan itself (a match, a visit sync)
export const bizConsentActors = ["patient", "system"] as const;

export interface IBizConsentLog extends MongoDoc {
  user: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  // the centre's name when it happened
  ownerName?: string;
  offer?: mongoose.Types.ObjectId;
  action: BizConsentAction;
  actor: (typeof bizConsentActors)[number];
  source: BizLinkSource;
  // the normalized mobile (09xxxxxxxxx) matched; masked wherever it is shown
  phone: string;
  // why a withdrawal happened (phoneChanged, contactGone, linkedElsewhere,
  // merged)
  reason?: string;
  // a link carried over by a merge: the consent row it rests on
  ref?: mongoose.Types.ObjectId;
  ip?: string;
  userAgent?: string;
  at: Date;
}

const BizConsentLogSchema = new mongoose.Schema<IBizConsentLog, Model<IBizConsentLog>>(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, immutable: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true, immutable: true },
    ownerKind: { type: String, enum: bizOwnerKinds, required: true, immutable: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true, immutable: true },
    ownerName: { type: String, maxlength: 200, immutable: true },
    offer: { type: mongoose.Schema.ObjectId, ref: "BizLinkOffer", immutable: true },
    action: { type: String, enum: bizConsentActions, required: true, immutable: true },
    actor: { type: String, enum: bizConsentActors, required: true, immutable: true },
    source: { type: String, enum: bizLinkSources, required: true, immutable: true },
    phone: { type: String, required: true, immutable: true },
    reason: { type: String, maxlength: 60, immutable: true },
    ref: { type: mongoose.Schema.ObjectId, ref: "BizConsentLog", immutable: true },
    ip: { type: String, maxlength: 60, immutable: true },
    userAgent: { type: String, maxlength: 400, immutable: true },
    at: { type: Date, default: () => new Date(), immutable: true },
  },
  { versionKey: false },
);

BizConsentLogSchema.index({ user: 1, at: -1 });
BizConsentLogSchema.index({ contact: 1, at: -1 });
BizConsentLogSchema.index({ ownerKind: 1, ownerId: 1, at: -1 });
BizConsentLogSchema.index({ action: 1, at: -1 });
BizConsentLogSchema.index({ at: -1 });

// append-only: a written row is never changed or removed through the app
const refuse = function () {
  throw new Error("BizConsentLog is append-only");
};
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const)
  BizConsentLogSchema.pre(op, refuse);
BizConsentLogSchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error("BizConsentLog is append-only"));
  next();
});

const BizConsentLog = mongoose.model("BizConsentLog", BizConsentLogSchema);
export default BizConsentLog;
