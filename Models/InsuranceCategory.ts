import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IInsuranceCategory extends MongoDoc {
  isActive: boolean;
  order: number;
  name?: string;
  slug?: string;
}

const InsuranceCategorySchema = new mongoose.Schema<
  IInsuranceCategory,
  Model<IInsuranceCategory>
>({
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  name: { type: String },
  slug: { type: String, unique: true, sparse: true },
});

InsuranceCategorySchema.plugin(translatable);

const InsuranceCategory = mongoose.model(
  "InsuranceCategory",
  InsuranceCategorySchema,
);

export default InsuranceCategory;
