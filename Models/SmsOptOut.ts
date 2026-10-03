import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// A phone that asked for no campaign SMS from any Noyan provider (2026-10,
// the opt-out page's "from all centres"). Checked on every campaign, on top
// of each contact's own opt-out and the operators' *800# block.
export interface ISmsOptOut extends MongoDoc {
  phone: string;
  at: Date;
}

const SmsOptOutSchema = new mongoose.Schema<ISmsOptOut, Model<ISmsOptOut>>({
  phone: { type: String, required: true, unique: true },
  at: { type: Date, default: () => new Date() },
});

const SmsOptOut = mongoose.model("SmsOptOut", SmsOptOutSchema);
export default SmsOptOut;
