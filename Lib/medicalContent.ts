import mongoose from "mongoose";

// Medical encyclopedia records (Disease, Drug, Symptom), 2026-10.
//
// Publish state: an admin can take a page off the site (to rewrite it, or
// while its content is being reviewed) without deleting it - deleting loses
// its comments, links and SEO history. Records saved before this field
// existed have no value and stay public, so the public filter is "not
// explicitly unpublished" rather than "published: true".
export const PUBLIC_MEDICAL = { published: { $ne: false } } as const;

// Medical review (the owner's decision, 2026-10-02): the page shows "medically
// reviewed by Dr X on <date>" only when a real doctor was recorded as the
// reviewer - the shield used to be drawn on every page. This is what Mayo
// Clinic, WebMD and Altibbi show, and what Google expects of YMYL pages.
export const medicalContentFields = {
  published: { type: Boolean, default: true },
  reviewedBy: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  reviewedAt: { type: Date },
};

export interface IMedicalContentFields {
  published: boolean;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
}

// what a public page needs of the reviewer: a name and a link to the profile
export const reviewerPopulation = {
  path: "reviewedBy",
  match: { active: true },
  select: "firstName lastName slug",
};

// Naming a reviewer stamps the review date unless the admin set one; clearing
// the reviewer clears the date, so a date never stands alone.
export const medicalReviewPlugin = (schema: mongoose.Schema) => {
  schema.pre("save", function (next) {
    const doc = this as unknown as IMedicalContentFields & mongoose.Document;
    if (doc.isModified("reviewedBy")) {
      if (!doc.reviewedBy) doc.reviewedAt = undefined;
      else if (!doc.isModified("reviewedAt") || !doc.reviewedAt)
        doc.reviewedAt = new Date();
    }
    next();
  });
  schema.pre(["findOneAndUpdate", "updateOne"], function (next) {
    const update = (this.getUpdate() || {}) as Record<string, any>;
    const set = (update.$set || update) as Record<string, any>;
    if (!("reviewedBy" in set)) return next();
    // a cleared picker arrives as "" (multipart forms) or "null"
    if (!set.reviewedBy || set.reviewedBy === "null" || set.reviewedBy === "undefined") {
      delete set.reviewedBy;
      delete set.reviewedAt;
      update.$unset = { ...(update.$unset || {}), reviewedBy: 1, reviewedAt: 1 };
    } else if (!set.reviewedAt) {
      set.reviewedAt = new Date();
    }
    this.setUpdate(update);
    next();
  });
};

// once at boot: records saved before the switch existed are public, and
// say so (the admin's switch showed them as "off" while the site showed them)
export const migrateMedicalPublished = async () => {
  for (const name of ["Disease", "Drug", "Symptom"]) {
    if (!mongoose.modelNames().includes(name)) continue;
    await mongoose
      .model(name)
      .updateMany({ published: { $exists: false } }, { $set: { published: true } });
  }
};
