import mongoose, { Model } from "mongoose";
import { IOldDoctor } from "./oldDoctor";
import { IOldSpeciality } from "./oldSpeciality";
import { MongoDoc } from "../User";

export const blogStatuses = ["Draft", "Publish", "Pending"] as const;

export interface IOldBlog extends MongoDoc {
  owner?: IOldDoctor;
  submittedAt: Date;
  status: string;
  publishedAt?: Date;
  name: string;
  slug?: string;
  summary?: string;
  image?: string;
  content?: string;
  mainContent?: string;
  featured: boolean;
  category?: string;
  isBlogs: boolean;
  related: IOldBlog[];
  doctors: IOldDoctor[];
  speciality?: IOldSpeciality;
}

const blogSchema = new mongoose.Schema<IOldBlog, Model<IOldBlog>>(
  {
    owner: { type: mongoose.Schema.ObjectId, ref: "Doctor" },
    submittedAt: { type: Date, default: () => new Date() },
    status: { type: String, default: "Draft", enum: blogStatuses },
    publishedAt: Date,
    name: { type: String, required: true, trim: true },
    slug: { type: String, sparse: true },
    summary: { type: String, trim: true },
    image: { type: String },
    content: { type: String },
    mainContent: { type: String },
    featured: { type: Boolean, default: false },
    category: { type: String, trim: true },
    isBlogs: { type: Boolean, default: false },
    related: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "Blog", required: true }],
      default: [],
    },
    doctors: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "Doctor", required: true }],
      default: [],
    },
    speciality: { type: mongoose.Schema.ObjectId, ref: "Speciality" },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

blogSchema.pre("findOneAndUpdate", function (next) {
  if ((this.getUpdate() as any)?.status === "Publish")
    this.setUpdate({ ...this.getUpdate(), publishedAt: new Date() });
  next();
});

blogSchema.virtual("comments", {
  ref: "Comment",
  localField: "_id",
  foreignField: "doc",
});

const OldBlog = mongoose.connection.useDb("Noyan").model("Blog", blogSchema);

export default OldBlog;
