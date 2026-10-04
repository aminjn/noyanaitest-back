import mongoose from "mongoose";
import Comment, {
  CommentableDocumentPath,
  ReviewBasisKind,
  reviewBasisOf,
} from "../Models/Comment";
import Reservation from "../Models/Reservation";
import Office from "../Models/Office";
import Order from "../Models/Order";
import ProductSeller from "../Models/ProductSeller";
import ParaClinicTest from "../Models/ParaClinicTest";

// Verified reviews (2026-10, Zocdoc / Doctolib / Paziresh24 "verified
// patient", Digikala "buyer"): a star rating on a centre or an item is
// accepted only from someone who had a completed visit there or bought it
// and got it, one review per visit / order line. The doctor's own reviews
// (DoctorFeedback) follow the same rule from the booking page.

// how long after the visit / purchase a review can still be left
export const VISIT_REVIEW_WINDOW_DAYS = 60;
export const PURCHASE_REVIEW_WINDOW_DAYS = 90;

const DAY = 24 * 3600 * 1000;

export type ReviewBasis = {
  kind: ReviewBasisKind;
  // the reservation, or the order line (its subdocument _id)
  ref: mongoose.Types.ObjectId;
  order?: mongoose.Types.ObjectId;
  // the visit / purchase date (the public badge shows its month)
  at: Date;
};

// order line arrays that can hold each purchasable model
const purchaseLines: Partial<
  Record<CommentableDocumentPath, "products" | "productPackages" | "services" | "servicePackages" | "tests">
> = {
  Product: "products",
  ProductPackage: "productPackages",
  Service: "services",
  ServicePackage: "servicePackages",
  ParaClinic: "tests",
};

const visitCandidates = async (
  user: mongoose.Types.ObjectId,
  refPath: CommentableDocumentPath,
  resource: mongoose.Types.ObjectId,
): Promise<ReviewBasis[]> => {
  const field = refPath === "Clinic" ? "clinic" : refPath === "Hospital" ? "hospital" : null;
  if (!field) return [];
  const offices = await Office.find({ [field]: resource }).distinct("_id");
  if (!offices.length) return [];
  const since = new Date(Date.now() - VISIT_REVIEW_WINDOW_DAYS * DAY);
  const rows = await Reservation.find({
    user,
    office: { $in: offices },
    status: "completed",
    $or: [{ finalizedAt: { $gte: since } }, { finalizedAt: { $exists: false }, date: { $gte: since } }],
  })
    .sort({ date: -1 })
    .limit(50)
    .select({ _id: 1, date: 1, finalizedAt: 1 })
    .lean();
  return rows.map((r) => ({
    kind: "visit" as const,
    ref: r._id as mongoose.Types.ObjectId,
    at: new Date((r.date as Date | undefined) ?? (r.finalizedAt as Date | undefined) ?? Date.now()),
  }));
};

const purchaseCandidates = async (
  user: mongoose.Types.ObjectId,
  refPath: CommentableDocumentPath,
  resource: mongoose.Types.ObjectId,
): Promise<ReviewBasis[]> => {
  const lines = purchaseLines[refPath];
  if (!lines) return [];
  // the order line points at what was sold: a pharmacy's offer of a
  // product, a lab's test, or the package / service itself
  const items: mongoose.Types.ObjectId[] =
    refPath === "Product"
      ? await ProductSeller.find({ product: resource }).distinct("_id")
      : refPath === "ParaClinic"
        ? await ParaClinicTest.find({ paraClinic: resource }).distinct("_id")
        : [resource];
  if (!items.length) return [];
  const since = new Date(Date.now() - PURCHASE_REVIEW_WINDOW_DAYS * DAY);
  const orders = await Order.find({
    user,
    status: "paid",
    submittedAt: { $gte: since },
    [lines]: { $elemMatch: { item: { $in: items }, status: "fulfilled" } },
  })
    .sort({ submittedAt: -1 })
    .limit(50)
    .select({ _id: 1, submittedAt: 1, paidAt: 1, [lines]: 1 })
    .lean();
  const wanted = new Set(items.map(String));
  const out: ReviewBasis[] = [];
  for (const order of orders) {
    const rows = (order as any)[lines];
    if (!Array.isArray(rows)) continue;
    for (const line of rows) {
      if (!line?._id || line.status !== "fulfilled" || !wanted.has(String(line.item))) continue;
      out.push({
        kind: "purchase",
        ref: line._id,
        order: order._id as mongoose.Types.ObjectId,
        at: new Date((order.paidAt as Date | undefined) ?? (order.submittedAt as Date)),
      });
    }
  }
  return out;
};

/**
 * The newest visit / delivered order line of this user that can still back
 * a review of the resource (completed, inside the window, not used by
 * another review of it). null when there is none.
 */
export const findReviewBasis = async (
  user: mongoose.Types.ObjectId,
  refPath: CommentableDocumentPath,
  resource: mongoose.Types.ObjectId,
): Promise<ReviewBasis | null> => {
  const kind = reviewBasisOf(refPath);
  if (!kind) return null;
  const candidates =
    kind === "visit"
      ? await visitCandidates(user, refPath, resource)
      : await purchaseCandidates(user, refPath, resource);
  if (!candidates.length) return null;
  const used = new Set(
    (
      await Comment.find({
        resource,
        verifiedBy: { $in: candidates.map((c) => c.ref) },
      }).distinct("verifiedBy")
    ).map(String),
  );
  return candidates.find((c) => !used.has(String(c.ref))) ?? null;
};
