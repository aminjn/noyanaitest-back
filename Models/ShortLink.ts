import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IShortLink extends MongoDoc {
  token: string;
  target: string;
}

const ShortLinkSchema = new mongoose.Schema<IShortLink, Model<IShortLink>>({
  token: { type: String, required: true, unique: true },
  target: { type: String, required: true },
});

const ShortLink = mongoose.model("ShortLink", ShortLinkSchema);

export default ShortLink;
