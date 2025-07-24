import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Score } from "./DoctorFeedback";

const commentableDocumentPaths = [
  "Blog",
  "Disease",
  "Symptom",
  "Drug",
  "Comment",
] as const;

type CommentableDocumentPath = (typeof commentableDocumentPaths)[number];

const commentStatuses = ["Pending", "Approved", "Rejected"] as const;

type CommentStatus = (typeof commentStatuses)[number];

export interface IComment extends MongoDoc {
  author: IUser;
  resource: mongoose.Types.ObjectId;
  refPath: CommentableDocumentPath;
  title: string;
  description: string;
  score: Score;
  upvotes: IUser[];
  downvotes: IUser[];
  status: CommentStatus;
  createdAt: Date;
}

const CommentSchema = new mongoose.Schema<IComment, Model<IComment>>({});

const Comment = mongoose.model("Comment", CommentSchema);

export default Comment;
