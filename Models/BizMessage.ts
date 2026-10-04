import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One CRM SMS to one contact (2026-10, Lib/business/crmSend.ts): a
// campaign's recipient, an automation's message or a one-off send from a
// contact's page. Written before the gateway is called; `dedupeKey` is
// unique, so an automation event (this visit's recall, this year's
// birthday) can never be sent twice, even across restarts or two job
// runs. `code` is the recipient's part of the tracked link
// (/l/<short link>-<code>): a click is counted here, and a booking made
// within 14 days of the message is attributed to it.
export const bizMessageStatuses = ["queued", "sent", "failed", "skipped"] as const;
export const bizMessageSources = ["campaign", "automation", "single", "sequence", "flow"] as const;

export interface IBizMessage extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  phone: string;
  source: (typeof bizMessageSources)[number];
  campaign?: mongoose.Types.ObjectId;
  automation?: mongoose.Types.ObjectId;
  template?: mongoose.Types.ObjectId;
  // the visit the message is about (recall, thanks, no-show)
  reservation?: mongoose.Types.ObjectId;
  dedupeKey?: string;
  text: string;
  parts: number;
  status: (typeof bizMessageStatuses)[number];
  // why it was skipped or failed (noCredit, optedOut, gateway, window)
  reason?: string;
  outboxId?: string;
  code?: string;
  // where the tracked link leads for this recipient, when not the short
  // link's own target (the review link of one visit)
  target?: string;
  clicks: number;
  clickedAt?: Date;
  bookedAt?: Date;
  sentAt?: Date;
  createdAt: Date;
}

const BizMessageSchema = new mongoose.Schema<IBizMessage, Model<IBizMessage>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    phone: { type: String, required: true },
    source: { type: String, enum: bizMessageSources, required: true },
    campaign: { type: mongoose.Schema.ObjectId, ref: "BizCampaign" },
    automation: { type: mongoose.Schema.ObjectId, ref: "BizAutomation" },
    template: { type: mongoose.Schema.ObjectId, ref: "BizTemplate" },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    dedupeKey: { type: String },
    text: { type: String, required: true, maxlength: 1200 },
    parts: { type: Number, default: 1 },
    status: { type: String, enum: bizMessageStatuses, default: "queued" },
    reason: { type: String, maxlength: 200 },
    outboxId: String,
    code: { type: String },
    target: { type: String, maxlength: 500 },
    clicks: { type: Number, default: 0 },
    clickedAt: Date,
    bookedAt: Date,
    sentAt: Date,
  },
  { timestamps: true },
);

BizMessageSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
BizMessageSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: "string" } } });
BizMessageSchema.index({ ownerKind: 1, ownerId: 1, contact: 1, createdAt: -1 });
BizMessageSchema.index({ campaign: 1, status: 1 });
BizMessageSchema.index({ automation: 1, createdAt: -1 });
BizMessageSchema.index({ ownerKind: 1, ownerId: 1, source: 1, createdAt: -1 });

const BizMessage = mongoose.model("BizMessage", BizMessageSchema);
export default BizMessage;
