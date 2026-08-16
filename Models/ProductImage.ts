import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IProduct } from "./Product";

export const productImageRefPaths = [
  "Product",
  "ProductPackage",
  "Service",
  "ServicePackage",
  "ParaClinic",
] as const;

export type ProductImageRefPath = (typeof productImageRefPaths)[number];

export interface IProductImage extends MongoDoc {
  product: IProduct;
  refPath: ProductImageRefPath;
  image: string;
  order: number;
  isActive: boolean;
  alt?: string;
}

const ProductImageSchema = new mongoose.Schema<
  IProductImage,
  Model<IProductImage>
>({
  product: {
    type: mongoose.Schema.ObjectId,
    refPath: "refPath",
    required: true,
  },
  refPath: {
    type: String,
    enum: productImageRefPaths,
    default: "Product",
    required: true,
  },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  image: { type: String, required: true },
  alt: { type: String },
});

const ProductImage = mongoose.model("ProductImage", ProductImageSchema);

export default ProductImage;
