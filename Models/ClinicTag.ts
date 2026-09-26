import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IClinicTag extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
}

const ClinicTagSchema = new mongoose.Schema<IClinicTag, Model<IClinicTag>>({
  name: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
});

ClinicTagSchema.plugin(translatable);

const ClinicTag = mongoose.model("ClinicTag", ClinicTagSchema);

export default ClinicTag;
