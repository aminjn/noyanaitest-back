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
  "Insurance",
  "DoctorProfile",
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
  averageScore: number;
  commentCount: number;
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
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
});

/**
 * Recomputes averageScore/commentCount on a commentable resource from its
 * Approved comments, and persists the result on that resource document.
 */
async function recalcResourceCommentStats(
  resource: mongoose.Types.ObjectId,
  refPath: CommentableDocumentPath,
) {
  const stats = await Comment.aggregate([
    { $match: { resource, status: "Approved" } },
    {
      $group: {
        _id: "$resource",
        averageScore: { $avg: "$score" },
        commentCount: { $sum: 1 },
      },
    },
  ]);

  const averageScore = stats[0]
    ? Math.round(stats[0].averageScore * 10) / 10
    : 0;
  const commentCount = stats[0]?.commentCount ?? 0;

  await mongoose
    .model(refPath)
    .findByIdAndUpdate(resource, { averageScore, commentCount });
}

// Creating a comment (Comment.create / new Comment().save()) can affect stats
// when the comment is already Approved.
CommentSchema.post("save", function (doc) {
  recalcResourceCommentStats(doc.resource, doc.refPath).catch((err) =>
    console.error("Failed to recalc comment stats after save:", err),
  );
});

// Updates (e.g. approving/rejecting a comment) and deletes both go through
// findOneAndUpdate / findOneAndDelete (including the findById* variants,
// which delegate to these under the hood). Capture the affected comment
// before the operation runs so we know which resource to recalc afterwards.
CommentSchema.pre(/^findOneAnd/, async function (next) {
  (this as any)._commentBeforeOp = await (this.model as any).findOne(
    (this as any).getFilter(),
  );
  next();
});

CommentSchema.post(/^findOneAnd/, function () {
  const before = (this as any)._commentBeforeOp as IComment | null;
  if (!before) return;
  recalcResourceCommentStats(before.resource, before.refPath).catch((err) =>
    console.error("Failed to recalc comment stats after update/delete:", err),
  );
});

const Comment = mongoose.model("Comment", CommentSchema);

export default Comment;
