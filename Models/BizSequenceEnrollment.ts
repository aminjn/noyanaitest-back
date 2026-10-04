import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One patient in one sequence (2026-10): the step it is at and when that
// step runs. A patient has at most one active enrollment per sequence.
// What each step did is kept in `log`.
export const bizEnrollmentStatuses = ["active", "completed", "stopped"] as const;

export interface IBizEnrollmentLog {
  step: number;
  at: Date;
  result: "sent" | "task" | "note" | "skipped" | "failed" | "waiting";
  reason?: string;
}

export interface IBizSequenceEnrollment extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  sequence: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  status: (typeof bizEnrollmentStatuses)[number];
  currentStep: number;
  nextRunAt?: Date;
  log: IBizEnrollmentLog[];
  // a workflow that enrolled them (its run)
  source?: string;
  stoppedAt?: Date;
  completedAt?: Date;
  createdBy?: IUser;
  createdAt: Date;
}

const BizSequenceEnrollmentSchema = new mongoose.Schema<IBizSequenceEnrollment, Model<IBizSequenceEnrollment>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    sequence: { type: mongoose.Schema.ObjectId, ref: "BizSequence", required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    status: { type: String, enum: bizEnrollmentStatuses, default: "active" },
    currentStep: { type: Number, default: 0 },
    nextRunAt: Date,
    log: {
      type: [
        new mongoose.Schema<IBizEnrollmentLog>(
          {
            step: Number,
            at: { type: Date, default: () => new Date() },
            result: { type: String, enum: ["sent", "task", "note", "skipped", "failed", "waiting"] },
            reason: { type: String, maxlength: 200 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    source: { type: String, maxlength: 100 },
    stoppedAt: Date,
    completedAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// one active enrollment of a patient in a sequence
BizSequenceEnrollmentSchema.index({ sequence: 1, contact: 1 }, { unique: true, partialFilterExpression: { status: "active" } });
BizSequenceEnrollmentSchema.index({ status: 1, nextRunAt: 1 });
BizSequenceEnrollmentSchema.index({ ownerKind: 1, ownerId: 1, sequence: 1, createdAt: -1 });

const BizSequenceEnrollment = mongoose.model("BizSequenceEnrollment", BizSequenceEnrollmentSchema);
export default BizSequenceEnrollment;
