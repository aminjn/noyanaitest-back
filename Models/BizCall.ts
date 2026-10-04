import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One phone call on a patient's file (2026-10, Nexxa CallLog): direction,
// outcome, length, what was said. It also writes a "call" entry on the
// patient's timeline (BizActivity), kept in step on edit and removed with
// it.
export const bizCallStatuses = ["completed", "missed", "noAnswer", "busy", "voicemail"] as const;

export interface IBizCall extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact?: mongoose.Types.ObjectId;
  lead?: mongoose.Types.ObjectId;
  direction: "inbound" | "outbound";
  status: (typeof bizCallStatuses)[number];
  phone?: string;
  startedAt: Date;
  durationSec: number;
  summary?: string;
  nextAction?: string;
  assignee?: mongoose.Types.ObjectId;
  activity?: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizCallSchema = new mongoose.Schema<IBizCall, Model<IBizCall>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    lead: { type: mongoose.Schema.ObjectId, ref: "BizLead" },
    direction: { type: String, enum: ["inbound", "outbound"], default: "inbound" },
    status: { type: String, enum: bizCallStatuses, default: "completed" },
    phone: { type: String, trim: true, maxlength: 20 },
    startedAt: { type: Date, default: () => new Date() },
    durationSec: { type: Number, default: 0, min: 0, max: 86400 },
    summary: { type: String, trim: true, maxlength: 4000 },
    nextAction: { type: String, trim: true, maxlength: 300 },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    activity: { type: mongoose.Schema.ObjectId, ref: "BizActivity" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizCallSchema.index({ ownerKind: 1, ownerId: 1, startedAt: -1 });
BizCallSchema.index({ ownerKind: 1, ownerId: 1, contact: 1 });

const BizCall = mongoose.model("BizCall", BizCallSchema);
export default BizCall;
