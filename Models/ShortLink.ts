import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IShortLink extends MongoDoc {
  token: string;
  target: string;
  // "crm": the tracked link of a CRM campaign or automation (2026-10,
  // Lib/business/crmSend.ts) - /l/<token>-<code> counts the recipient's click
  source?: string;
}

const ShortLinkSchema = new mongoose.Schema<IShortLink, Model<IShortLink>>({
  token: { type: String, required: true, unique: true },
  target: { type: String, required: true },
  source: { type: String },
});

const ShortLink = mongoose.model("ShortLink", ShortLinkSchema);

export default ShortLink;
