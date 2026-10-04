import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One assignment rule (2026-10, Nexxa AssignmentRule / territory.ts): the
// first active rule, in order, whose conditions all hold names who takes a
// new treatment inquiry - one person, or the least-loaded member of a team.
// The CRM sales score rules (Nexxa ScoreRule) share the shape: kind
// "score" with points instead of an assignee.
export interface IBizCondition {
  field: string;
  op: string;
  value: string;
}

export interface IBizAssignRule extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: "assign" | "score";
  name: string;
  order: number;
  active: boolean;
  conditions: IBizCondition[];
  assignType: "user" | "team";
  user?: mongoose.Types.ObjectId;
  team?: mongoose.Types.ObjectId;
  stopOnMatch: boolean;
  points: number;
  createdAt: Date;
}

const CondSchema = new mongoose.Schema<IBizCondition>(
  {
    field: { type: String, required: true, maxlength: 40 },
    op: { type: String, required: true, maxlength: 20 },
    value: { type: String, default: "", maxlength: 200 },
  },
  { _id: false },
);

const BizAssignRuleSchema = new mongoose.Schema<IBizAssignRule, Model<IBizAssignRule>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: ["assign", "score"], default: "assign" },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    conditions: { type: [CondSchema], default: [] },
    assignType: { type: String, enum: ["user", "team"], default: "user" },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    team: { type: mongoose.Schema.ObjectId, ref: "BizTeam" },
    stopOnMatch: { type: Boolean, default: true },
    points: { type: Number, default: 0, min: -1000, max: 1000 },
  },
  { timestamps: true },
);

BizAssignRuleSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, order: 1 });

const BizAssignRule = mongoose.model("BizAssignRule", BizAssignRuleSchema);
export default BizAssignRule;
