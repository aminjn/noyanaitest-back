import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A staff quiz (2026-10, nexxacrm's kbQuiz): multiple-choice questions,
// marked on the server; `correct` is never sent to someone taking it.
export interface IBizQuizQuestion {
  _id: mongoose.Types.ObjectId;
  text: string;
  options: string[];
  // the indexes of the right options (one or more)
  correct: number[];
}

export interface IBizQuiz extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  // the article it tests (optional)
  article?: mongoose.Types.ObjectId;
  // percent needed to pass
  passScore: number;
  active: boolean;
  questions: IBizQuizQuestion[];
  createdBy?: IUser;
  createdAt: Date;
}

const QuestionSchema = new mongoose.Schema<IBizQuizQuestion>({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  options: { type: [{ type: String, trim: true, maxlength: 300 }], default: [] },
  correct: { type: [Number], default: [] },
});

const BizQuizSchema = new mongoose.Schema<IBizQuiz, Model<IBizQuiz>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 1000 },
    article: { type: mongoose.Schema.ObjectId, ref: "BizKbArticle" },
    passScore: { type: Number, min: 0, max: 100, default: 70 },
    active: { type: Boolean, default: true },
    questions: { type: [QuestionSchema], default: [] },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizQuizSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });

const BizQuiz = mongoose.model("BizQuiz", BizQuizSchema);
export default BizQuiz;
