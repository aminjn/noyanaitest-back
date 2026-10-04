import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One run of a workflow for one event (2026-10): the step it is at, why it
// waits (a delay until resumeAt, an approval) and what every step did.
// `dedupeKey` (flow + event) is unique: an event runs a workflow once.
export const bizFlowRunStatuses = ["running", "waitingDelay", "waitingApproval", "done", "failed", "cancelled"] as const;
export type BizFlowRunStatus = (typeof bizFlowRunStatuses)[number];

export interface IBizFlowLog {
  step: number;
  kind: string;
  result: "ok" | "yes" | "no" | "waiting" | "approved" | "rejected" | "skipped" | "failed";
  note?: string;
  at: Date;
}

export interface IBizFlowRun extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  flow: mongoose.Types.ObjectId;
  trigger: string;
  entityType: string;
  entityId: string;
  contact?: mongoose.Types.ObjectId;
  dedupeKey: string;
  status: BizFlowRunStatus;
  step: number;
  resumeAt?: Date;
  log: IBizFlowLog[];
  finishedAt?: Date;
  createdAt: Date;
}

const BizFlowRunSchema = new mongoose.Schema<IBizFlowRun, Model<IBizFlowRun>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    flow: { type: mongoose.Schema.ObjectId, ref: "BizFlow", required: true },
    trigger: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    dedupeKey: { type: String, required: true, unique: true },
    status: { type: String, enum: bizFlowRunStatuses, default: "running" },
    step: { type: Number, default: 0 },
    resumeAt: Date,
    log: {
      type: [
        new mongoose.Schema<IBizFlowLog>(
          {
            step: Number,
            kind: String,
            result: { type: String, enum: ["ok", "yes", "no", "waiting", "approved", "rejected", "skipped", "failed"] },
            note: { type: String, maxlength: 300 },
            at: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    finishedAt: Date,
  },
  { timestamps: true },
);

BizFlowRunSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });
BizFlowRunSchema.index({ flow: 1, createdAt: -1 });
BizFlowRunSchema.index({ status: 1, resumeAt: 1 });

const BizFlowRun = mongoose.model("BizFlowRun", BizFlowRunSchema);
export default BizFlowRun;
