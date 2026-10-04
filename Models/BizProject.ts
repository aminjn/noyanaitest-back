import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A board of team tasks (2026-10, nexxacrm's project): a patient's surgery
// coordination, a lab's monthly quality control, opening a new branch.
// Its stages are the board's columns; a task in a closed stage is done.
export const bizProjectStatuses = ["active", "onHold", "done", "cancelled"] as const;

export interface IBizProjectStage {
  _id: mongoose.Types.ObjectId;
  name: string;
  isClosed: boolean;
}

export interface IBizProject extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  color?: string;
  dueAt?: Date;
  contact?: mongoose.Types.ObjectId;
  status: (typeof bizProjectStatuses)[number];
  stages: IBizProjectStage[];
  createdBy?: IUser;
  createdAt: Date;
}

const StageSchema = new mongoose.Schema<IBizProjectStage>({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  isClosed: { type: Boolean, default: false },
});

const BizProjectSchema = new mongoose.Schema<IBizProject, Model<IBizProject>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000 },
    color: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
    dueAt: Date,
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    status: { type: String, enum: bizProjectStatuses, default: "active" },
    stages: { type: [StageSchema], default: [] },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizProjectSchema.index({ ownerKind: 1, ownerId: 1, status: 1, createdAt: -1 });

const BizProject = mongoose.model("BizProject", BizProjectSchema);
export default BizProject;
