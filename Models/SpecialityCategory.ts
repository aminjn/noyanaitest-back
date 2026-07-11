import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ISpecialityCategory extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
  slug?: string;
}

const SpecialityCategorySchema = new mongoose.Schema<
  ISpecialityCategory,
  Model<ISpecialityCategory>
>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  slug: { type: String, unique: true, sparse: true },
});

const SpecialityCategory = mongoose.model(
  "SpecialityCategory",
  SpecialityCategorySchema,
);

export default SpecialityCategory;
