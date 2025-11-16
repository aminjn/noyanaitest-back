import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

const badEventPlaces = [
  "GetIdentity",
  "GetIdentityOther",
  "matchNationalIdAndPhone",
  "matchNationalIdAndPhoneOther",
  "GetMedicalCodes",
  "GetMcDetails",
] as const;

type BadEventPlace = (typeof badEventPlaces)[number];

export interface IBadEvent extends MongoDoc {
  createdAt: Date;
  place: BadEventPlace;
  payload?: string;
}

const BadEventSchema = new mongoose.Schema<IBadEvent, Model<IBadEvent>>({
  createdAt: { type: Date, default: () => new Date() },
  place: { type: String, enum: badEventPlaces, required: true },
  payload: { type: String },
});

const BadEvent = mongoose.model("BadEvent", BadEventSchema);

export default BadEvent;
