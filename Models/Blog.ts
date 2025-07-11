import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IBlogCategory } from "./BlogCategory";

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
  readTime?: string;
  //TODO: caloculate relaled based on same category
  related: IBlog[];
  thisWeekSpecial: boolean;
  home: boolean;
  published: boolean;
  category?: IBlogCategory;
}

const BlogSchema = new mongoose.Schema<IBlog, Model<IBlog>>({
  image: { type: String },
  title: { type: String },
  summary: { type: String },
  publishedAt: { type: Date, default: () => new Date() },
  order: { type: Number, default: 0 },
  slug: { type: String, sparse: true, trim: true },
  content: { type: String },
  author: { type: String },
  readTime: { type: String },
  related: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Blog", required: true }],
    default: [],
  },
  thisWeekSpecial: { type: Boolean, default: false },
  home: { type: Boolean, default: false },
  published: { type: Boolean, default: false },
  category: { type: mongoose.Schema.ObjectId, ref: "BlogCategory" },
});

const Blog = mongoose.model("Blog", BlogSchema);

export default Blog;
