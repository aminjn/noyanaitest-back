import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A workflow of one owner (2026-10, Lib/business/crmService/flow.ts),
// nexxacrm's automation engine: a trigger (an event of the centre), the
// conditions the patient must meet, then steps run in order - a condition
// (no = stop), a delay, an approval in a team member's inbox (reject =
// stop or go on) and actions (an SMS template, a follow-up, a task, a note,
// a tag, a notice to the team, a sequence, club points). Every run and
// what each step did is kept (Models/BizFlowRun.ts); one event runs a
// workflow once.
//
// The six ready-made journeys (Models/BizAutomation.ts: recall, thanks,
// birthday, no-show, win-back, chronic) keep running as they are; this is
// the general engine beside them.
export const bizFlowTriggers = [
  "visit.completed",
  "visit.noShow",
  "visit.cancelled",
  "contact.created",
  "ticket.created",
  "ticket.resolved",
  "invoice.issued",
  "club.redeemed",
  "sequence.completed",
  "return.created",
] as const;
export type BizFlowTrigger = (typeof bizFlowTriggers)[number];

export const bizFlowStepKinds = ["condition", "delay", "approval", "action"] as const;
export const bizFlowActions = [
  "sendSms",
  "followUp",
  "task",
  "note",
  "addTag",
  "removeTag",
  "notify",
  "enrollSequence",
  "clubPoints",
] as const;
export type BizFlowAction = (typeof bizFlowActions)[number];

// a contact field compared with a value (nexxacrm's rules.ts Condition)
export const bizFlowFields = ["tags", "visits", "orders", "spent", "noShows", "gender", "insurer", "city", "source", "tier", "age"] as const;
export const bizFlowOps = ["eq", "neq", "contains", "in", "gt", "lt", "empty", "notempty"] as const;
export interface IBizFlowCondition {
  field: (typeof bizFlowFields)[number];
  op: (typeof bizFlowOps)[number];
  value?: string;
}

export interface IBizFlowStep {
  _id: mongoose.Types.ObjectId;
  kind: (typeof bizFlowStepKinds)[number];
  // condition
  conditions?: IBizFlowCondition[];
  // delay
  days?: number;
  hours?: number;
  // approval: who decides (a team member; empty = the panel's owner)
  approver?: mongoose.Types.ObjectId;
  title?: string;
  onReject?: "stop" | "continue";
  // action
  action?: BizFlowAction;
  template?: mongoose.Types.ObjectId;
  text?: string;
  tag?: string;
  dueDays?: number;
  assignee?: mongoose.Types.ObjectId;
  sequence?: mongoose.Types.ObjectId;
  project?: mongoose.Types.ObjectId;
  points?: number;
}

export interface IBizFlow extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  trigger: BizFlowTrigger;
  active: boolean;
  enabledAt?: Date;
  // the trigger's own filter (the first condition of nexxacrm's graph)
  filters: IBizFlowCondition[];
  steps: IBizFlowStep[];
  // the polled triggers (visits, contacts, invoices): events up to here
  // were already looked at
  cursor?: Date;
  runCount: number;
  lastRunAt?: Date;
  createdBy?: IUser;
  createdAt: Date;
}

const ConditionSchema = new mongoose.Schema<IBizFlowCondition>(
  {
    field: { type: String, enum: bizFlowFields, required: true },
    op: { type: String, enum: bizFlowOps, required: true },
    value: { type: String, maxlength: 200 },
  },
  { _id: false },
);

const StepSchema = new mongoose.Schema<IBizFlowStep>({
  kind: { type: String, enum: bizFlowStepKinds, required: true },
  conditions: { type: [ConditionSchema], default: undefined },
  days: { type: Number, min: 0, max: 365 },
  hours: { type: Number, min: 0, max: 23 },
  approver: { type: mongoose.Schema.ObjectId, ref: "User" },
  title: { type: String, trim: true, maxlength: 200 },
  onReject: { type: String, enum: ["stop", "continue"] },
  action: { type: String, enum: bizFlowActions },
  template: { type: mongoose.Schema.ObjectId, ref: "BizTemplate" },
  text: { type: String, trim: true, maxlength: 500 },
  tag: { type: String, trim: true, maxlength: 40 },
  dueDays: { type: Number, min: 0, max: 365 },
  assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
  sequence: { type: mongoose.Schema.ObjectId, ref: "BizSequence" },
  project: { type: mongoose.Schema.ObjectId, ref: "BizProject" },
  points: { type: Number, min: -100_000, max: 100_000 },
});

const BizFlowSchema = new mongoose.Schema<IBizFlow, Model<IBizFlow>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    trigger: { type: String, enum: bizFlowTriggers, required: true },
    active: { type: Boolean, default: false },
    enabledAt: Date,
    filters: { type: [ConditionSchema], default: [] },
    steps: { type: [StepSchema], default: [] },
    cursor: Date,
    runCount: { type: Number, default: 0 },
    lastRunAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizFlowSchema.index({ ownerKind: 1, ownerId: 1, trigger: 1, active: 1 });
BizFlowSchema.index({ active: 1, trigger: 1 });

const BizFlow = mongoose.model("BizFlow", BizFlowSchema);
export default BizFlow;
