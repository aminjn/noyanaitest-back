import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface Singleton extends MongoDoc {
  singleton: "SINGLETON";
}

const contentKeys = [
  "homePage",
  "officeBook",
  "medicalConsult",
  "phoneConsult",
  "textConsult",
  "aiDetection",
  "blog",
  "forDoctors",
  "login",
] as const;

type ContentKey = (typeof contentKeys)[number];

export type ITextContent = Singleton & {
  [key in ContentKey]: string;
};

const TextContentSchema = new mongoose.Schema<
  ITextContent,
  Model<ITextContent>
>({
  singleton: {
    type: String,
    required: true,
    immutable: true,
    unique: true,
    trim: true,
    enum: ["SINGLETON"],
    default: "SINGLETON",
  },
  ...contentKeys.reduce(
    (acc, key) => ({ ...acc, [key]: { type: String, default: key } }),
    {}
  ),
});

const TextContent = mongoose.model("TextContent", TextContentSchema);

export default TextContent;
