import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IBlogRRS extends MongoDoc {
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

const BlogRRSSchema = new mongoose.Schema<IBlogRRS, Model<IBlogRRS>>(
  {
    email: { type: String },
  },
  { timestamps: true },
);

const BlogRRS = mongoose.model("BlogRRS", BlogRRSSchema);

export default BlogRRS;
