import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IBlogCategory } from "./BlogCategory";
import { IBlogMedia } from "./BlogMedia";
import { IBlogTag } from "./BlogTag";

// Mirrors Controllers/aclController's NodeWithAcl. Kept as a local literal
// union (instead of importing from the controller layer) to avoid a
// Model -> Controller dependency.
export type BlogAuthorOrgType =
  | "doctor"
  | "insurance"
  | "pharmacy"
  | "clinic"
  | "paraClinic"
  | "hospital";

export interface IBlog extends MongoDoc {
  image?: string;
  title?: string;
  summary?: string;
  publishedAt: Date;
  order: number;
  slug?: string;
  content?: string;
  //TODO: auto fill author with currently logged in user
  author?: string;
  // Set when a blog is submitted by an organization panel (doctor/clinic/
  // pharmacy/insurance/paraClinic) rather than written by an admin.
  // authorOrg points at that org's own profile document (Doctor/Clinic/...).
  // Org-authored posts always come in with published=false and stay that
  // way until an admin reviews and publishes them from the admin blog panel.
  authorType?: BlogAuthorOrgType;
  authorOrg?: mongoose.Types.ObjectId;
  // legacy hand-typed text; readMinutes (computed from content) wins
  readTime?: string;
  readMinutes?: number;
  // the admin's review of a post a provider submitted (none on the admin's
  // own posts): pending until approved (published) or rejected with a
  // reason the provider sees in their panel
  reviewStatus?: BlogReviewStatus;
  rejectReason?: string;
  //TODO: caloculate relaled based on same category
  related: IBlog[];
  thisWeekSpecial: boolean;
  home: boolean;
  published: boolean;
  viewCount: number;
  category?: IBlogCategory;
  preloadMedias: IBlogMedia[];
  old?: mongoose.Types.ObjectId;
  averageScore: number;
  commentCount: number;
  recommended: boolean;
  chosen: boolean;
  tags: IBlogTag[];
}

export const blogReviewStatuses = ["pending", "approved", "rejected"] as const;
export type BlogReviewStatus = (typeof blogReviewStatuses)[number];

// a provider's post that waits for the admin: marked pending, or (posts
// sent before the review state existed) unpublished and never decided
export const blogAwaitingReviewFilter = {
  authorOrg: { $exists: true },
  published: false,
  reviewStatus: { $nin: ["approved", "rejected"] },
};

const BlogSchema = new mongoose.Schema<IBlog, Model<IBlog>>({
  image: { type: String },
  title: { type: String },
  summary: { type: String },
  publishedAt: { type: Date, default: () => new Date() },
  order: { type: Number, default: 0 },
  slug: { type: String, sparse: true, trim: true, unique: true },
  content: { type: String },
  author: { type: String },
  authorType: {
    type: String,
    enum: [
      "doctor",
      "insurance",
      "pharmacy",
      "clinic",
      "paraClinic",
      "hospital",
    ],
  },
  authorOrg: { type: mongoose.Schema.ObjectId },
  readTime: { type: String },
  readMinutes: { type: Number },
  reviewStatus: { type: String, enum: blogReviewStatuses },
  rejectReason: { type: String, trim: true, maxlength: 500 },
  related: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Blog", required: true }],
    default: [],
  },
  thisWeekSpecial: { type: Boolean, default: false },
  home: { type: Boolean, default: false },
  published: { type: Boolean, default: false },
  // public page views - what "most viewed" sorts by
  viewCount: { type: Number, default: 0, min: 0 },
  category: { type: mongoose.Schema.ObjectId, ref: "BlogCategory" },
  preloadMedias: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "BlogMedia", required: true },
    ],
    default: [],
  },
  old: { type: mongoose.Schema.ObjectId },
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  recommended: { type: Boolean, default: false },
  chosen: { type: Boolean, default: false },
  tags: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "BlogTag", required: true }],
    default: [],
  },
});

// the published date follows the publish switch: a post approved weeks
// after it was written is dated the day it went out (unless the admin set
// the date in the same change)
BlogSchema.pre("save", function (next) {
  if (this.isModified("published") && this.published && !this.isNew && !this.isModified("publishedAt")) this.publishedAt = new Date();
  next();
});
BlogSchema.pre("findOneAndUpdate", async function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = (update.$set || update) as Record<string, any>;
  if (set.published !== true && set.published !== "true") return;
  const before = await this.model
    .findOne(this.getQuery())
    .select("published authorOrg")
    .lean<{ published?: boolean; authorOrg?: unknown }>();
  // publishing a provider's post is approving it
  if (before?.authorOrg && set.reviewStatus === undefined) {
    set.reviewStatus = "approved";
    update.$unset = { ...(update.$unset || {}), rejectReason: 1 };
    this.setUpdate(update);
  }
  if (set.publishedAt !== undefined) return;
  if (before && !before.published) set.publishedAt = new Date();
});

// reading time is computed from the text (2026-10), ~200 words a minute, and
// each language renders it with its own "N min" text; it was a free-typed
// Persian string shown to every language
export const readMinutesOf = (html: unknown) => {
  const text = String(html || "").replace(/<[^>]*>/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 200)) : undefined;
};
BlogSchema.pre("save", function (next) {
  if (this.isNew || this.isModified("content")) this.set("readMinutes", readMinutesOf(this.get("content")));
  next();
});
BlogSchema.pre("findOneAndUpdate", function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = (update.$set || update) as Record<string, any>;
  if (set.content !== undefined) set.readMinutes = readMinutesOf(set.content);
});

BlogSchema.plugin(translatable);

const Blog = mongoose.model("Blog", BlogSchema);

export default Blog;
