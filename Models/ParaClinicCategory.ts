import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IParaClinicCategory extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  slug?: string;
}

const ParaClinicCategorySchema = new mongoose.Schema<
  IParaClinicCategory,
  Model<IParaClinicCategory>
>({
  name: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  slug: { type: String, unique: true, sparse: true },
});

const ParaClinicCategory = mongoose.model(
  "ParaClinicCategory",
  ParaClinicCategorySchema,
);

export default ParaClinicCategory;
