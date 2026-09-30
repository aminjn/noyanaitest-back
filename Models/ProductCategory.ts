import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IProductCategory extends MongoDoc {
  name?: string;
  slug?: string;
  order: number;
  isActive: boolean;
}

const ProductCategorySchema = new mongoose.Schema<
  IProductCategory,
  Model<IProductCategory>
>({
  name: { type: String, required: [true, "نام الزامی است"], trim: true },
  // readable menu URLs (/product?category=<slug>), filled by the slug job
  slug: { type: String, unique: true, sparse: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
});

ProductCategorySchema.plugin(translatable);

const ProductCategory = mongoose.model(
  "ProductCategory",
  ProductCategorySchema,
);

export default ProductCategory;
