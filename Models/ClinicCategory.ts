import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { fa } from "zod/locales";

export interface IClinicCategory extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  slug?: string;
}

const ClinicCategorySchema = new mongoose.Schema<
  IClinicCategory,
  Model<IClinicCategory>
>({
  name: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  slug: { type: String, unique: true, sparse: true },
});

const ClinicCategory = mongoose.model("ClinicCategory", ClinicCategorySchema);

export default ClinicCategory;
