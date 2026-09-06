import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ILicenseDuration extends MongoDoc {
  duration: number;
  displayName?: string;
  order: number;
}

const LicenseDurationSchema = new mongoose.Schema<
  ILicenseDuration,
  Model<ILicenseDuration>
>({
  duration: { type: Number, required: true },
  displayName: { type: String },
  order: { type: Number, default: 0 },
});

const LicenseDuration = mongoose.model(
  "LicenseDuration",
  LicenseDurationSchema,
);

export default LicenseDuration;
