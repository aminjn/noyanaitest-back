import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IBlogTag extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  hot: boolean;
}

const BlogTagSchema = new mongoose.Schema<IBlogTag, Model<IBlogTag>>({
  name: { type: String, trim: true, required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  hot: { type: Boolean, default: false },
});

BlogTagSchema.plugin(translatable);

const BlogTag = mongoose.model("BlogTag", BlogTagSchema);

export default BlogTag;
