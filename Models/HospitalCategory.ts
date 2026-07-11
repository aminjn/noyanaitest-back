import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IHospitalCategory extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
}

const HospitalCategorySchema = new mongoose.Schema<
  IHospitalCategory,
  Model<IHospitalCategory>
>({
  name: { type: String },
  slug: { type: String, unique: true, sparse: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

const HospitalCategory = mongoose.model(
  "HospitalCategory",
  HospitalCategorySchema,
);

export default HospitalCategory;
