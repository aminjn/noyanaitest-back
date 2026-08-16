import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

const pages = ["Privacy", "Policy"] as const;

type Page = (typeof pages)[number];

export interface IPrivacySection extends MongoDoc {
  title?: string;
  content?: string;
  isActive: boolean;
  order: number;
  page: Page;
}

const PrivacySectionSchema = new mongoose.Schema<
  IPrivacySection,
  Model<IPrivacySection>
>({
  title: { type: String },
  content: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  page: { type: String, enum: pages, required: true },
});

const PrivacySection = mongoose.model("PrivacySection", PrivacySectionSchema);

export default PrivacySection;
