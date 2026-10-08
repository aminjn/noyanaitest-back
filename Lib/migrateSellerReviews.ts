import mongoose from "mongoose";
import Comment, { recalcResourceCommentStats } from "../Models/Comment";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";

// One-off (2026-10, seller reviews): pharmacies get the averageScore /
// commentCount a lab already has, and a lab review is now one per order
// (it was one per test line): an existing lab review's proof moves from
// its line to its order. When one order had several line reviews, the
// newest keeps the order and the older ones keep their line (they still
// count, nothing is deleted). Marked in `migrations`; safe to re-run.
const MARKER = "sellerReviews-2026-10";

export const migrateSellerReviews = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const markers = db.collection<{ _id: string; at: Date }>("migrations");
  if (await markers.findOne({ _id: MARKER })) return;

  await Pharmacy.updateMany(
    { averageScore: { $exists: false } },
    { $set: { averageScore: 0, commentCount: 0 } },
  );

  const labReviews = await Comment.find({
    refPath: "ParaClinic",
    verified: true,
    verifiedOrder: { $exists: true },
  })
    .select("+verifiedBy +verifiedOrder resource createdAt")
    .sort({ createdAt: -1 })
    .lean();
  let moved = 0;
  for (const review of labReviews) {
    if (!review.verifiedOrder || String(review.verifiedBy) === String(review.verifiedOrder)) continue;
    const taken = await Comment.exists({
      resource: review.resource,
      verifiedBy: review.verifiedOrder,
    });
    if (taken) continue;
    await Comment.updateOne({ _id: review._id }, { $set: { verifiedBy: review.verifiedOrder } }).catch(() => {});
    moved += 1;
  }

  const ids = new Map<string, mongoose.Types.ObjectId>();
  for (const id of [
    ...(await Comment.find({ refPath: { $in: ["Pharmacy", "ParaClinic"] } }).distinct("resource")),
    ...(await ParaClinic.find({ commentCount: { $gt: 0 } }).distinct("_id")),
  ])
    ids.set(String(id), id as mongoose.Types.ObjectId);
  for (const id of Array.from(ids.values())) {
    const refPath = (await Pharmacy.exists({ _id: id })) ? "Pharmacy" : "ParaClinic";
    await recalcResourceCommentStats(id, refPath).catch(() => {});
  }

  await markers.updateOne({ _id: MARKER }, { $set: { at: new Date() } }, { upsert: true });
  console.log(`[reviews] seller reviews migrated (${moved} lab reviews moved to their order)`);
};
