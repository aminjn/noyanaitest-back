import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Hours a team member spent on a task (2026-10, nexxacrm's timeLog): the
// timesheet. Changed or removed only by whoever logged it or the owner.
export interface IBizTimeLog extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  task: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  hours: number;
  date: Date;
  note?: string;
  billable: boolean;
  createdAt: Date;
}

const BizTimeLogSchema = new mongoose.Schema<IBizTimeLog, Model<IBizTimeLog>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    task: { type: mongoose.Schema.ObjectId, ref: "BizTask", required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    hours: { type: Number, required: true, min: 0.05, max: 24 },
    date: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 300 },
    billable: { type: Boolean, default: false },
  },
  { timestamps: true },
);

BizTimeLogSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizTimeLogSchema.index({ task: 1 });

const BizTimeLog = mongoose.model("BizTimeLog", BizTimeLogSchema);
export default BizTimeLog;
