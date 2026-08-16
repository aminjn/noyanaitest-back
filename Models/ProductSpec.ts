import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IProduct } from "./Product";
import { ProductImageRefPath, productImageRefPaths } from "./ProductImage";

export interface IProductSpec extends MongoDoc {
  product: IProduct;
  refPath: ProductImageRefPath;
  order: number;
  isActive: boolean;
  title?: string;
  content?: string;
}

const ProductSpecSchema = new mongoose.Schema<
  IProductSpec,
  Model<IProductSpec>
>({
  product: { type: mongoose.Schema.ObjectId, ref: "refPath", required: true },
  refPath: {
    type: String,
    enum: productImageRefPaths,
    default: "Product",
    required: true,
  },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  title: { type: String },
  content: { type: String },
});

const ProductSpec = mongoose.model("ProductSpec", ProductSpecSchema);

export default ProductSpec;
