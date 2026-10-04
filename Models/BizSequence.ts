import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A multi-step follow-up of one owner (2026-10, Lib/business/crmService/
// sequence.ts), nexxacrm's «سکوئنس»: after a first visit, before an
// operation. A patient is enrolled; each step waits `waitDays` after the
// previous one and then sends an approved SMS template (quota then wallet,
// inside the send window), gives a follow-up task to a team member, or
// writes a note on the patient's file.
export const bizSequenceChannels = ["sms", "task", "note"] as const;
export type BizSequenceChannel = (typeof bizSequenceChannels)[number];

export interface IBizSequenceStep {
  _id: mongoose.Types.ObjectId;
  channel: BizSequenceChannel;
  waitDays: number;
  // sms: the approved template sent
  template?: mongoose.Types.ObjectId;
  // task / note: its text
  text?: string;
  // task: who gets it (empty = the panel's owner)
  assignee?: mongoose.Types.ObjectId;
}

export interface IBizSequence extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  active: boolean;
  steps: IBizSequenceStep[];
  createdBy?: IUser;
  createdAt: Date;
}

const StepSchema = new mongoose.Schema<IBizSequenceStep>({
  channel: { type: String, enum: bizSequenceChannels, default: "sms" },
  waitDays: { type: Number, min: 0, max: 365, default: 0 },
  template: { type: mongoose.Schema.ObjectId, ref: "BizTemplate" },
  text: { type: String, trim: true, maxlength: 500 },
  assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
});

const BizSequenceSchema = new mongoose.Schema<IBizSequence, Model<IBizSequence>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    active: { type: Boolean, default: false },
    steps: { type: [StepSchema], default: [] },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizSequenceSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });

const BizSequence = mongoose.model("BizSequence", BizSequenceSchema);
export default BizSequence;
