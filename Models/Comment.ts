import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Score, scores } from "./DoctorFeedback";

export const commentableDocumentPaths = [
  "Blog",
  "Disease",
  "Symptom",
  "Drug",
  "Comment",
  "Product",
  "Clinic",
  "ProductPackage",
  "Service",
  "ServicePackage",
  "ParaClinic",
  "Hospital",
  "Insurance"
] as const;

export type CommentableDocumentPath = (typeof commentableDocumentPaths)[number];

const commentStatuses = ["Pending", "Approved", "Rejected"] as const;

type CommentStatus = (typeof commentStatuses)[number];

export interface IComment extends MongoDoc {
  author: IUser;
  resource: mongoose.Types.ObjectId;
  refPath: CommentableDocumentPath;
  content: string;
  score: Score;
  upvotes: IUser[];
  status: CommentStatus;
  createdAt: Date;
}

const CommentSchema = new mongoose.Schema<IComment, Model<IComment>>({
  author: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  resource: {
    type: mongoose.Schema.ObjectId,
    refPath: "refPath",
    required: true,
  },
  refPath: { type: String, required: true, enum: commentableDocumentPaths },
  content: { type: String },
  score: { type: Number, enum: scores, default: 5 },
  upvotes: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
  status: { type: String, enum: commentStatuses, default: "Pending" },
  createdAt: { type: Date, default: () => new Date() },
});

const Comment = mongoose.model("Comment", CommentSchema);

export default Comment;
