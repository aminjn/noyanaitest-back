import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IFaqCategory extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
}

const FaqCategorySchema = new mongoose.Schema<
  IFaqCategory,
  Model<IFaqCategory>
>({
  name: { type: String },
  slug: { type: String, unique: true, sparse: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

FaqCategorySchema.plugin(translatable);

const FaqCategory = mongoose.model("FaqCategory", FaqCategorySchema);

export default FaqCategory;
