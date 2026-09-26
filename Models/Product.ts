import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import { IProductCategory } from "./ProductCategory";
import { IProductImage } from "./ProductImage";

export interface IProduct extends MongoDoc {
  name?: string;
  slug?: string;
  image?: string;
  order: number;
  isActive: boolean;
  category: IProductCategory;
  summary?: string;
  description?: string;
  whyChoose?: string;
  details?: string;
  usage?: string;
  warning?: string;
  special: boolean;
  original?: string;
  sameAs: IProduct[];
  price: number;
  averageScore: number;
  commentCount: number;
}

const ProductSchema = new mongoose.Schema<IProduct, Model<IProduct>>(
  {
    image: { type: String },
    name: { type: String },
    slug: { type: String, unique: true, sparse: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    category: { type: mongoose.Schema.ObjectId, ref: "ProductCategory" },
    summary: { type: String },
    description: { type: String },
    whyChoose: { type: String },
    details: { type: String },
    usage: { type: String },
    warning: { type: String },
    original: { type: String },
    sameAs: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Product", required: true },
      ],
      default: [],
    },
    price: { type: Number, default: 0 },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ProductSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.virtual("specs", {
  ref: "ProductSpec",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.virtual("sellers", {
  ref: "ProductSeller",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.plugin(translatable);

const Product = mongoose.model("Product", ProductSchema);

export default Product;
