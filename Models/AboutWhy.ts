import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const aboutWhyElems = ["Why", "Principle"] as const;

export type AboutWhyElem = (typeof aboutWhyElems)[number];

export interface IAboutWhy extends MongoDoc {
  title?: string;
  content?: string;
  isActive: boolean;
  order: number;
  elem: AboutWhyElem;
}

const AboutWhySchema = new mongoose.Schema<IAboutWhy, Model<IAboutWhy>>({
  title: { type: String },
  content: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  elem: { type: String, enum: aboutWhyElems, required: true },
});

const AboutWhy = mongoose.model("AboutWhy", AboutWhySchema);

export default AboutWhy;
