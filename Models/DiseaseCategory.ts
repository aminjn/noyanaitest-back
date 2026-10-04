import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";

export interface IDiseaseCategory extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
}

const DiseaseCategorySchema = new mongoose.Schema<
  IDiseaseCategory,
  Model<IDiseaseCategory>
>({
  name: { type: String, trim: true, required: true },
  slug: { type: String, unique: true, sparse: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

DiseaseCategorySchema.plugin(translatable);
clearsDirectoryCache(DiseaseCategorySchema);

const DiseaseCategory = mongoose.model(
  "DiseaseCategory",
  DiseaseCategorySchema,
);

export default DiseaseCategory;
