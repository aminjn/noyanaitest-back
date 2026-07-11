import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProductSeller } from "./ProductSeller";

export const cartModels = ["products"] as const;

export interface ICart extends MongoDoc {
  owner: IUser;
  products: { item: IProductSeller; qty: number }[];
}

const CartSchema = new mongoose.Schema<ICart, Model<ICart>>({
  owner: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  products: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "ProductSeller",
          required: true,
        },
        qty: { type: Number, required: true },
      },
    ],
    default: [],
  },
});

const Cart = mongoose.model("Cart", CartSchema);

export default Cart;
