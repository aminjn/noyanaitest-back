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
  // a pharmacy as a seller (2026-10): rated by buyers of a delivered order
  "Pharmacy",
] as const;

export type CommentableDocumentPath = (typeof commentableDocumentPaths)[number];

// Verified reviews (2026-10): which commentable models carry a star rating
// that feeds their public score, and what proves the reviewer used them -
// a completed visit (reservation at one of the centre's offices) or a
// delivered order line. Everything else (blog, disease, symptom, drug,
// insurance, replies) is open Q&A: text only, no stars, no score.
// DoctorProfile is rated through DoctorFeedback (post-visit), never here.
export const reviewBasisKinds = ["visit", "purchase"] as const;
export type ReviewBasisKind = (typeof reviewBasisKinds)[number];

const reviewBasisByPath: Partial<Record<CommentableDocumentPath, ReviewBasisKind>> = {
  Clinic: "visit",
  Hospital: "visit",
  ParaClinic: "purchase",
  Pharmacy: "purchase",
  Product: "purchase",
  ProductPackage: "purchase",
  Service: "purchase",
  ServicePackage: "purchase",
};

export const reviewBasisOf = (
  refPath: CommentableDocumentPath | string,
): ReviewBasisKind | null =>
  reviewBasisByPath[refPath as CommentableDocumentPath] ?? null;

export const isRatedPath = (refPath: CommentableDocumentPath | string) =>
  !!reviewBasisOf(refPath);

// Seller reviews (2026-10, Digikala / Snappfood / Halodoc "rate your
// order"): a pharmacy or a lab is rated as the seller of an order - one
// review per order, from its buyer, once a line from that seller was
// delivered (pharmacy) or its result given (lab). Besides the stars the
// buyer can tick a few quick tags of what went well, which the public page
// sums up ("12 buyers mention fast delivery").
export const sellerReviewPaths = ["Pharmacy", "ParaClinic"] as const;
export type SellerReviewPath = (typeof sellerReviewPaths)[number];
export const isSellerReviewPath = (
  refPath: CommentableDocumentPath | string,
): refPath is SellerReviewPath =>
  (sellerReviewPaths as readonly string[]).includes(refPath);

export const reviewTagsByPath: Record<SellerReviewPath, readonly string[]> = {
  Pharmacy: ["deliverySpeed", "packaging", "correctItems", "staffAdvice"],
  ParaClinic: ["sampling", "punctuality", "resultSpeed", "clarity"],
};
// Negative quick tags (2026-10, Snappfood / Digikala "what went wrong"): a
// low rating (score <= NEGATIVE_TAG_MAX_SCORE) offers what went wrong
// instead of what went well. They are private feedback for the seller and
// the admin: never in a public list nor in the public tag summary.
export const NEGATIVE_TAG_MAX_SCORE = 2;
export const negativeReviewTagsByPath: Record<SellerReviewPath, readonly string[]> = {
  Pharmacy: ["lateDelivery", "damagedPackaging", "wrongItems", "unhelpfulStaff"],
  ParaClinic: ["samplingProblem", "keptWaiting", "resultLate", "resultUnclear"],
};
export const negativeReviewTags: readonly string[] = Array.from(
  new Set(Object.values(negativeReviewTagsByPath).flat()),
);
export const isNegativeReviewTag = (tag: unknown) =>
  typeof tag === "string" && negativeReviewTags.includes(tag);
export const reviewTags = Array.from(
  new Set([...Object.values(reviewTagsByPath).flat(), ...negativeReviewTags]),
);
// the positive tags of a page (the form at score >= 3, the public summary)
export const reviewTagsOf = (refPath: CommentableDocumentPath | string): readonly string[] =>
  isSellerReviewPath(refPath) ? reviewTagsByPath[refPath] : [];
export const negativeReviewTagsOf = (
  refPath: CommentableDocumentPath | string,
): readonly string[] =>
  isSellerReviewPath(refPath) ? negativeReviewTagsByPath[refPath] : [];
// the tags a review with this score may carry (polarity follows the score)
export const reviewTagsForScore = (
  refPath: CommentableDocumentPath | string,
  score: number,
): readonly string[] =>
  score <= NEGATIVE_TAG_MAX_SCORE ? negativeReviewTagsOf(refPath) : reviewTagsOf(refPath);

export const commentStatuses = ["Pending", "Approved", "Rejected"] as const;

type CommentStatus = (typeof commentStatuses)[number];

export interface IComment extends MongoDoc {
  author: IUser;
  resource: mongoose.Types.ObjectId;
  refPath: CommentableDocumentPath;
  content: string;
  // only on rated paths (see reviewBasisOf); open Q&A carries none
  score?: Score;
  upvotes: IUser[];
  status: CommentStatus;
  createdAt: Date;
  averageScore: number;
  commentCount: number;
  // moderation (2026-10): why it was rejected, by whom and when
  rejectReason?: string;
  moderatedBy?: mongoose.Types.ObjectId;
  moderatedAt?: Date;
  // verified review (2026-10): what proves the author used it - the
  // reservation, or the order line (subdocument _id) of verifiedOrder - and
  // when (the public badge shows the month). Only verified reviews count
  // toward averageScore / commentCount on rated paths.
  verified?: boolean;
  verifiedKind?: ReviewBasisKind;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedOrder?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  // the provider's one public reply
  reply?: { content: string; at: Date; by?: mongoose.Types.ObjectId };
  // quick tags of a seller review (reviewTagsByPath, or
  // negativeReviewTagsByPath at a low score - those stay private)
  tags?: string[];
}

const CommentSchema = new mongoose.Schema<IComment, Model<IComment>>({
  author: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  resource: {
    type: mongoose.Schema.ObjectId,
    refPath: "refPath",
    required: true,
  },
  refPath: { type: String, required: true, enum: commentableDocumentPaths },
  // optional on a rated review (stars alone are a review); required for
  // open Q&A by the controller
  content: { type: String },
  score: { type: Number, enum: scores },
  tags: { type: [{ type: String, enum: reviewTags }], default: undefined },
  upvotes: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
  status: { type: String, enum: commentStatuses, default: "Pending" },
  createdAt: { type: Date, default: () => new Date() },
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  rejectReason: { type: String, trim: true, maxlength: 500 },
  // staff identity stays out of public payloads
  moderatedBy: { type: mongoose.Schema.ObjectId, ref: "User", select: false },
  moderatedAt: { type: Date },
  verified: { type: Boolean, default: false },
  verifiedKind: { type: String, enum: reviewBasisKinds },
  // private links back to the visit / order, never in public payloads
  verifiedBy: { type: mongoose.Schema.ObjectId, select: false },
  verifiedOrder: { type: mongoose.Schema.ObjectId, ref: "Order", select: false },
  verifiedAt: { type: Date },
  reply: {
    type: new mongoose.Schema(
      {
        content: { type: String, trim: true, maxlength: 1000, required: true },
        at: { type: Date, default: () => new Date() },
        by: { type: mongoose.Schema.ObjectId, ref: "User", select: false },
      },
      { _id: false },
    ),
  },
});

// one review per visit / order line of a resource
CommentSchema.index(
  { resource: 1, verifiedBy: 1 },
  { unique: true, partialFilterExpression: { verifiedBy: { $exists: true } } },
);
CommentSchema.index({ resource: 1, status: 1, createdAt: -1 });

/**
 * Recomputes averageScore/commentCount on a commentable resource and
 * persists them on it. Rated paths: Approved *verified* reviews only. Open
 * Q&A paths: commentCount is the Approved comments, averageScore 0 (no
 * stars, no rating in search or structured data).
 */
export async function recalcResourceCommentStats(
  resource: mongoose.Types.ObjectId,
  refPath: CommentableDocumentPath,
) {
  // a doctor's score is DoctorFeedback's (recalcDoctorFeedbackStats); a
  // legacy doctor comment must not overwrite it
  if (refPath === "DoctorProfile") return;
  const rated = isRatedPath(refPath);
  if (!rated) {
    const commentCount = await Comment.countDocuments({
      resource,
      status: "Approved",
    });
    await mongoose
      .model(refPath)
      .findByIdAndUpdate(resource, { averageScore: 0, commentCount });
    return;
  }
  const stats = await Comment.aggregate([
    { $match: { resource, status: "Approved", verified: true } },
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
