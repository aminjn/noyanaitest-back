import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";
import { bizRulesSchema, IBizRules } from "./BizSegment";

// One SMS campaign of one owner (2026-10, Lib/business/campaign.ts):
//   Draft     - being written
//   Pending   - waiting in the super admin's /requests queue (capitalized
//               like the queue's other requests, whose reject/reopen it uses)
//   Rejected  - sent back with a reason (edit and submit again)
//   Approved  - cleared; goes out at the next allowed hour (the super
//               admin's send window, 08:00-21:00 by default)
//   Sending   - charged and going out
//   Sent      - done (sentCount / failedCount); what did not go out was
//               given back once (Lib/business/campaign.ts finishCampaign)
//   Cancelled - dropped by the owner before it went out
// Only the owner's own contacts (people who visited or bought) who have not
// opted out receive it; every message carries an opt-out link. It is paid
// from the plan's monthly SMS quota first, then from the Noyan wallet.
export const bizCampaignStatuses = ["Draft", "Pending", "Rejected", "Approved", "Sending", "Sent", "Cancelled"] as const;

// the contact rules (Models/BizSegment.ts), or a saved segment (read live
// when the campaign is estimated and sent), or a hand-picked selection
export interface IBizAudience extends IBizRules {
  tags: string[];
  sources: string[];
  segment?: mongoose.Types.ObjectId;
  contactIds?: mongoose.Types.ObjectId[];
}

export interface IBizCampaign extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  text: string;
  audience: IBizAudience;
  // the template the text started from (a copy: the campaign's own text is
  // what the super admin clears)
  template?: mongoose.Types.ObjectId;
  // the owner's chosen send time (else as soon as approved), and its own
  // send window inside 08-21 Tehran
  sendAt?: Date;
  windowFrom?: number;
  windowUntil?: number;
  // the tracked link's short link token ({link} in the text), and what it
  // brought: recipients who clicked, bookings within 14 days
  linkToken?: string;
  clicks: number;
  bookings: number;
  status: (typeof bizCampaignStatuses)[number];
  // what the owner saw when it was submitted
  recipients: number;
  parts: number;
  rejectReason?: string;
  submittedAt?: Date;
  decidedAt?: Date;
  decidedBy?: IUser;
  sendAfter?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  sentCount: number;
  failedCount: number;
  // what it cost: SMS parts from the plan quota, from the wallet, the price
  // of one part and the wallet transaction
  fromQuota: number;
  fromWallet: number;
  unitPrice: number;
  charged: number;
  refunded: number;
  transaction?: mongoose.Types.ObjectId;
  // development / test: the messages were only written to the server log
  // (Lib/business/crmSend.ts sendOne), charged like a real send
  simulated?: boolean;
  createdBy?: IUser;
  createdAt: Date;
}

const BizCampaignSchema = new mongoose.Schema<IBizCampaign, Model<IBizCampaign>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    text: { type: String, required: true, maxlength: 1000 },
    audience: {
      ...bizRulesSchema,
      tags: { type: [String], default: [] },
      sources: { type: [String], default: [] },
      segment: { type: mongoose.Schema.ObjectId, ref: "BizSegment" },
      contactIds: { type: [mongoose.Schema.ObjectId], default: undefined },
    },
    template: { type: mongoose.Schema.ObjectId, ref: "BizTemplate" },
    sendAt: Date,
    // inside the super admin's window (Lib/smsPolicy.ts), clamped when sent
    windowFrom: { type: Number, min: 0, max: 23 },
    windowUntil: { type: Number, min: 1, max: 24 },
    linkToken: String,
    clicks: { type: Number, default: 0 },
    bookings: { type: Number, default: 0 },
    status: { type: String, enum: bizCampaignStatuses, default: "Draft" },
    recipients: { type: Number, default: 0 },
    parts: { type: Number, default: 1 },
    rejectReason: { type: String, maxlength: 500 },
    submittedAt: Date,
    decidedAt: Date,
    decidedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    sendAfter: Date,
    startedAt: Date,
    finishedAt: Date,
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    fromQuota: { type: Number, default: 0 },
    fromWallet: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    charged: { type: Number, default: 0 },
    refunded: { type: Number, default: 0 },
    transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
    simulated: Boolean,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizCampaignSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });
BizCampaignSchema.index({ status: 1, sendAfter: 1 });

const BizCampaign = mongoose.model("BizCampaign", BizCampaignSchema);
export default BizCampaign;
