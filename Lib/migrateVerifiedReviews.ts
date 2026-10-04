import mongoose from "mongoose";
import Comment, {
  CommentableDocumentPath,
  commentableDocumentPaths,
  recalcResourceCommentStats,
} from "../Models/Comment";
import DoctorFeedBack, { recalcDoctorFeedbackStats } from "../Models/DoctorFeedback";
import DoctorProfile from "../Models/DoctorProfile";

// One-off (2026-10, verified reviews): every stored averageScore /
// commentCount / feedbackCount is recomputed under the new rule - only
// approved, verified reviews feed a rated record's score; open Q&A pages
// (blog, disease, drug...) keep a comment count and no rating. Runs once,
// marked in the `migrations` collection; safe to re-run (it only
// recomputes).
const MARKER = "verifiedReviews-2026-10";

export const migrateVerifiedReviews = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const markers = db.collection<{ _id: string; at: Date }>("migrations");
  if (await markers.findOne({ _id: MARKER })) return;

  let resources = 0;
  for (const refPath of commentableDocumentPaths) {
    if (refPath === "DoctorProfile" || refPath === "Comment") continue;
    let model: mongoose.Model<any>;
    try {
      model = mongoose.model(refPath);
    } catch {
      continue;
    }
    const withStats = await model
      .find({ $or: [{ averageScore: { $gt: 0 } }, { commentCount: { $gt: 0 } }] })
      .distinct("_id");
    const withComments = await Comment.find({ refPath }).distinct("resource");
    const ids = new Map<string, mongoose.Types.ObjectId>();
    for (const id of [...withStats, ...withComments]) ids.set(String(id), id);
    for (const id of Array.from(ids.values())) {
      await recalcResourceCommentStats(id, refPath as CommentableDocumentPath).catch(() => {});
      resources += 1;
    }
  }

  const doctorIds = new Map<string, mongoose.Types.ObjectId>();
  for (const id of [
    ...(await DoctorProfile.find({
      $or: [{ averageScore: { $gt: 0 } }, { feedbackCount: { $gt: 0 } }],
    }).distinct("_id")),
    ...(await DoctorFeedBack.distinct("doctor")),
  ])
    doctorIds.set(String(id), id as mongoose.Types.ObjectId);
  for (const id of Array.from(doctorIds.values()))
    await recalcDoctorFeedbackStats(id).catch(() => {});

  await markers.updateOne(
    { _id: MARKER },
    { $set: { at: new Date() } },
    { upsert: true },
  );
  console.log(
    `[reviews] scores recomputed from verified reviews: ${resources} records, ${doctorIds.size} doctors`,
  );
};
