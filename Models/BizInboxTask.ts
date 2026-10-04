import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One decision waiting in a team member's CRM inbox (2026-10, «کارتابل»,
// nexxacrm's approvalTask): an approval step of a workflow run, or the
// current level of a request's approval chain (Lib/business/crmService/
// approvalChain.ts: a return). One-way: approve, or reject with a reason.
export const bizInboxStatuses = ["pending", "approved", "rejected", "cancelled"] as const;

export interface IBizInboxTask extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  // "flow" (a run's approval step) or a chain type ("return")
  entityType: string;
  entityId: string;
  run?: mongoose.Types.ObjectId;
  step?: number;
  level?: number;
  title: string;
  detail?: string;
  approver: mongoose.Types.ObjectId;
  status: (typeof bizInboxStatuses)[number];
  note?: string;
  decidedAt?: Date;
  createdAt: Date;
}

const BizInboxTaskSchema = new mongoose.Schema<IBizInboxTask, Model<IBizInboxTask>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    run: { type: mongoose.Schema.ObjectId, ref: "BizFlowRun" },
    step: Number,
    level: Number,
    title: { type: String, required: true, maxlength: 300 },
    detail: { type: String, maxlength: 1000 },
    approver: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    status: { type: String, enum: bizInboxStatuses, default: "pending" },
    note: { type: String, maxlength: 500 },
    decidedAt: Date,
  },
  { timestamps: true },
);

BizInboxTaskSchema.index({ ownerKind: 1, ownerId: 1, approver: 1, status: 1, createdAt: -1 });
BizInboxTaskSchema.index({ entityType: 1, entityId: 1, status: 1 });

const BizInboxTask = mongoose.model("BizInboxTask", BizInboxTaskSchema);
export default BizInboxTask;
