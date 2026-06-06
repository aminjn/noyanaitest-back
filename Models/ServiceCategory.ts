import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IServiceCategory extends MongoDoc {
  title?: string;
  isActive: boolean;
  order: number;
  slug?: string;
}

const ServiceCategorySchema = new mongoose.Schema<
  IServiceCategory,
  Model<IServiceCategory>
>({
  title: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  slug: { type: String, unique: true, sparse: true },
});

const ServiceCategory = mongoose.model(
  "ServiceCategory",
  ServiceCategorySchema,
);

export default ServiceCategory;
