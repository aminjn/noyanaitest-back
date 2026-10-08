import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IServiceCategory extends MongoDoc {
  title?: string;
  isActive: boolean;
  order: number;
  slug?: string;
  // added by a doctor from the profile (Lib/serviceCatalog.ts): live on that
  // doctor's page, out of the global lists until an admin approves or merges
  pendingReview?: boolean;
  suggestedBy?: mongoose.Types.ObjectId;
}

const ServiceCategorySchema = new mongoose.Schema<
  IServiceCategory,
  Model<IServiceCategory>
>({
  title: { type: String, trim: true, required: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  slug: { type: String, unique: true, sparse: true },
  pendingReview: { type: Boolean, default: false, index: true },
  suggestedBy: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
});

ServiceCategorySchema.plugin(translatable);

const ServiceCategory = mongoose.model(
  "ServiceCategory",
  ServiceCategorySchema,
);

export default ServiceCategory;
