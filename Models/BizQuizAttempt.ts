import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One team member's answers to a quiz, marked on the server (2026-10).
// A passed attempt is the member's certificate.
export interface IBizQuizAttempt extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  quiz: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  answers: number[][];
  correctCount: number;
  total: number;
  score: number;
  passed: boolean;
  createdAt: Date;
}

const BizQuizAttemptSchema = new mongoose.Schema<IBizQuizAttempt, Model<IBizQuizAttempt>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    quiz: { type: mongoose.Schema.ObjectId, ref: "BizQuiz", required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    answers: { type: [[Number]], default: [] },
    correctCount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

BizQuizAttemptSchema.index({ ownerKind: 1, ownerId: 1, quiz: 1, user: 1, createdAt: -1 });

const BizQuizAttempt = mongoose.model("BizQuizAttempt", BizQuizAttemptSchema);
export default BizQuizAttempt;
