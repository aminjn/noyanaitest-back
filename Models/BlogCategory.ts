import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IBlogCategory extends MongoDoc {
  title?: string;
  slug?: string;
  order: number;
}

const BlogCategorySchema = new mongoose.Schema<
  IBlogCategory,
  Model<IBlogCategory>
>({
  title: { type: String },
  slug: { type: String, sparse: true, trim: true, unique: true },
  order: { type: Number, default: 0 },
});

BlogCategorySchema.plugin(translatable);

const BlogCategory = mongoose.model("BlogCategory", BlogCategorySchema);

export default BlogCategory;
