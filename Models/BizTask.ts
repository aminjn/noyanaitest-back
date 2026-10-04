import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A team task on a board (2026-10, nexxacrm's task): optionally about a
// patient, given to a team member, with a priority (0-3), a due date and
// sub-tasks (`parent`, same board). Moving it to a closed stage marks it
// done; ticking it done leaves the stage as it is (nexxacrm's own rule).
export interface IBizTask extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  project: mongoose.Types.ObjectId;
  stage: mongoose.Types.ObjectId;
  parent?: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  priority: number;
  dueAt?: Date;
  assignee?: mongoose.Types.ObjectId;
  contact?: mongoose.Types.ObjectId;
  done: boolean;
  doneAt?: Date;
  // the due date already reminded
  remindedAt?: Date;
  createdBy?: IUser;
  createdAt: Date;
}

const BizTaskSchema = new mongoose.Schema<IBizTask, Model<IBizTask>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    project: { type: mongoose.Schema.ObjectId, ref: "BizProject", required: true },
    stage: { type: mongoose.Schema.ObjectId, required: true },
    parent: { type: mongoose.Schema.ObjectId, ref: "BizTask" },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 3000 },
    priority: { type: Number, min: 0, max: 3, default: 1 },
    dueAt: Date,
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    done: { type: Boolean, default: false },
    doneAt: Date,
    remindedAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizTaskSchema.index({ ownerKind: 1, ownerId: 1, project: 1, stage: 1 });
BizTaskSchema.index({ ownerKind: 1, ownerId: 1, assignee: 1, done: 1, dueAt: 1 });
BizTaskSchema.index({ done: 1, remindedAt: 1, dueAt: 1 });

const BizTask = mongoose.model("BizTask", BizTaskSchema);
export default BizTask;
