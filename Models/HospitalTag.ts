import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IHospitalTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
}

const HospitalTagSchema = new mongoose.Schema<
  IHospitalTag,
  Model<IHospitalTag>
>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

HospitalTagSchema.plugin(translatable);

const HospitalTag = mongoose.model("HospitalTag", HospitalTagSchema);

export default HospitalTag;
