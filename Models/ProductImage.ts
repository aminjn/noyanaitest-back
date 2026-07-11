import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IProduct } from "./Product";

export interface IProductImage extends MongoDoc {
  product: IProduct;
  image: string;
  order: number;
  isActive: boolean;
  alt?: string;
}

const ProductImageSchema = new mongoose.Schema<
  IProductImage,
  Model<IProductImage>
>({
  product: { type: mongoose.Schema.ObjectId, ref: "Product", required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  image: { type: String, required: true },
  alt: { type: String },
});

const ProductImage = mongoose.model("ProductImage", ProductImageSchema);

export default ProductImage;
