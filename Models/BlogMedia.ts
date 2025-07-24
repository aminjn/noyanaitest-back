import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IBlogMedia extends MongoDoc {
  name?: string;
  file?: string;
  createdAt: Date;
}

const BlogMediaSchema = new mongoose.Schema<IBlogMedia, Model<IBlogMedia>>({
  name: { type: String },
  file: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

const BlogMedia = mongoose.model("BlogMedia", BlogMediaSchema);

export default BlogMedia;
