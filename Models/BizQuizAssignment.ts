import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A quiz given to the whole team or to one member, with a due date
// (2026-10, nexxacrm's kbQuizAssignment; its "team" scope is the panel's
// own team here: "all").
export interface IBizQuizAssignment extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  quiz: mongoose.Types.ObjectId;
  scope: "all" | "user";
  user?: mongoose.Types.ObjectId;
  dueDate?: Date;
  createdBy?: IUser;
  createdAt: Date;
}

const BizQuizAssignmentSchema = new mongoose.Schema<IBizQuizAssignment, Model<IBizQuizAssignment>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    quiz: { type: mongoose.Schema.ObjectId, ref: "BizQuiz", required: true },
    scope: { type: String, enum: ["all", "user"], required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    dueDate: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizQuizAssignmentSchema.index({ ownerKind: 1, ownerId: 1, quiz: 1 });

const BizQuizAssignment = mongoose.model("BizQuizAssignment", BizQuizAssignmentSchema);
export default BizQuizAssignment;
