import mongoose, { Model } from "mongoose";
import { discountWithinPrice } from "../Lib/priceRules";
import { MongoDoc } from "./User";
import { IProduct } from "./Product";
import { IPharmacy } from "./Pharmacy";

export interface IProductSeller extends MongoDoc {
  product: IProduct;
  seller: IPharmacy;
  order: number;
  isActive: boolean;
  price: number;
  discount: number;
  special: boolean;
  freeDelivery: boolean;
  fastDelivery: boolean;
}

const ProductSellerSchema = new mongoose.Schema<
  IProductSeller,
  Model<IProductSeller>
>({
  product: { type: mongoose.Schema.ObjectId, ref: "Product", required: true },
  seller: { type: mongoose.Schema.ObjectId, ref: "Pharmacy", required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  price: { type: Number, default: 0, min: 0 },
  discount: { type: Number, default: 0, min: 0, validate: discountWithinPrice },
  special: { type: Boolean, default: false },
  fastDelivery: { type: Boolean, default: false },
  freeDelivery: { type: Boolean, default: false },
});

ProductSellerSchema.index({ product: 1, seller: 1 }, { unique: true });

const ProductSeller = mongoose.model("ProductSeller", ProductSellerSchema);

export default ProductSeller;
