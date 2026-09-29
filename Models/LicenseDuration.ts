import { translatable } from "../Lib/i18n/translatable";
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
  // months; a zero or negative plan length is meaningless
  duration: { type: Number, required: true, min: 1 },
  displayName: { type: String },
  order: { type: Number, default: 0 },
});

// the plan-length label ("3 months") is shown to providers in every language
LicenseDurationSchema.plugin(translatable);

const LicenseDuration = mongoose.model(
  "LicenseDuration",
  LicenseDurationSchema,
);

export default LicenseDuration;
