import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import { IProductCategory } from "./ProductCategory";
import { IProduct } from "./Product";
import { IProductImage } from "./ProductImage";

export interface IProductPackage extends MongoDoc {
  owner: IPharmacy;
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
  category?: IProductCategory;
  image?: string;
  products: IProduct[];
  price: number;
  discount: number;
  summary?: string;
  description?: string;
  whyChoose?: string;
  sameAs: IProductPackage[];
  averageScore: number;
  commentCount: number;
}

const ProductPackageSchema = new mongoose.Schema<
  IProductPackage,
  Model<IProductPackage>
>(
  {
    owner: { type: mongoose.Schema.ObjectId, ref: "Pharmacy", required: true },
    name: { type: String },
    slug: { type: String, unique: true, sparse: true },
    isActive: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    category: { type: mongoose.Schema.ObjectId, ref: "ProductCategory" },
    image: { type: String },
    products: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Product", required: true },
      ],
      default: [],
    },
    price: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    summary: { type: String },
    description: { type: String },
    whyChoose: { type: String },
    sameAs: {
      type: [
        {
          type: mongoose.Schema.ObjectId,
          ref: "ProductPackage",
          required: true,
        },
      ],
      default: [],
    },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ProductPackageSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ProductPackageSchema.virtual("specs", {
  ref: "ProductSpec",
  localField: "_id",
  foreignField: "product",
});

const ProductPackage = mongoose.model("ProductPackage", ProductPackageSchema);

export default ProductPackage;
