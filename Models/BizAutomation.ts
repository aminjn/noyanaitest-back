import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";
import { BizRulesSchema, IBizRules } from "./BizSegment";

// A rule-based patient journey of one owner (2026-10, Lib/business/
// crmAutomation.ts), run by a job every few minutes:
//   recall   - N days after a completed visit (of the chosen session types),
//              unless they already booked again
//   thanks   - N hours after a completed visit: thank-you + the verified
//              review link of that visit
//   birthday - on the patient's (Jalali) birthday
//   noShow   - N hours after a visit they missed, unless they booked again
//   winback  - when a patient passes N days with no visit or order
//   chronic  - for patients with the chosen tags (e.g. diabetes): N days
//              after their last visit, the periodic check-up reminder
// Each sends one approved template, inside its own send window (never
// outside 08:00-21:00 Tehran), to contacts who match its audience and have
// not opted out, paid from the plan's quota then the wallet. A message is
// recorded before it is sent under a unique key (Models/BizMessage.ts
// dedupeKey), so one event never reaches a patient twice, and no contact
// gets another automated SMS from this owner within `gapDays`.
export const bizAutomationKinds = ["recall", "thanks", "birthday", "noShow", "winback", "chronic"] as const;
export type BizAutomationKind = (typeof bizAutomationKinds)[number];

export interface IBizAutomation extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: BizAutomationKind;
  name: string;
  enabled: boolean;
  enabledAt?: Date;
  template?: mongoose.Types.ObjectId;
  // days (recall, winback, chronic) or hours (thanks, noShow) after the event
  delay: number;
  // recall: only visits of these session types (empty = any)
  sessionTypes: string[];
  audience: IBizRules;
  // Tehran hours, inside 08-21
  windowFrom: number;
  windowUntil: number;
  // no other automated SMS from this owner to the same contact within N days
  gapDays: number;
  // birthday / winback / chronic: at most once a year per contact
  oncePerYear: boolean;
  // the tracked link's short link token ({link} / {review} in the text)
  linkToken?: string;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  lastRunAt?: Date;
  lastError?: string;
  createdBy?: IUser;
  createdAt: Date;
}

const BizAutomationSchema = new mongoose.Schema<IBizAutomation, Model<IBizAutomation>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: bizAutomationKinds, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    enabled: { type: Boolean, default: false },
    enabledAt: Date,
    template: { type: mongoose.Schema.ObjectId, ref: "BizTemplate" },
    delay: { type: Number, default: 0, min: 0, max: 3650 },
    sessionTypes: { type: [String], default: [] },
    audience: { type: BizRulesSchema, default: {} },
    windowFrom: { type: Number, default: 10, min: 8, max: 20 },
    windowUntil: { type: Number, default: 19, min: 9, max: 21 },
    gapDays: { type: Number, default: 3, min: 0, max: 60 },
    oncePerYear: { type: Boolean, default: true },
    linkToken: String,
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    lastRunAt: Date,
    lastError: { type: String, maxlength: 300 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizAutomationSchema.index({ ownerKind: 1, ownerId: 1, kind: 1 });
BizAutomationSchema.index({ enabled: 1 });

const BizAutomation = mongoose.model("BizAutomation", BizAutomationSchema);
export default BizAutomation;
