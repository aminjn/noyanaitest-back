import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";

export interface ISymptomCategory extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
}

const SymptomCategorySchema = new mongoose.Schema<
  ISymptomCategory,
  Model<ISymptomCategory>
>({
  name: { type: String, trim: true, required: true },
  slug: { type: String, unique: true, sparse: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

SymptomCategorySchema.plugin(translatable);
clearsDirectoryCache(SymptomCategorySchema);

const SymptomCategory = mongoose.model(
  "SymptomCategory",
  SymptomCategorySchema,
);

export default SymptomCategory;
