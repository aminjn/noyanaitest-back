import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProductSeller } from "./ProductSeller";
import { IProductPackage } from "./ProductPackage";
import { IService } from "./Service";
import { IServicePackage } from "./ServicePackage";
import { required } from "zod/mini";
import { IParaClinicTest } from "./ParaClinicTest";

export const cartModels = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
] as const;

export interface ICart extends MongoDoc {
  owner: IUser;
  products: { item: IProductSeller; qty: number }[];
  productPackages: { item: IProductPackage; qty: number }[];
  services: { item: IService; qty: number }[];
  servicePackages: { item: IServicePackage; qty: number }[];
  tests: { item: IParaClinicTest; qty: number }[];
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
        qty: { type: Number, required: true, min: 1 },
      },
    ],
    default: [],
  },
  productPackages: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "ProductPackage",
          required: true,
        },
        qty: { type: Number, required: true, min: 1 },
      },
    ],
    default: [],
  },
  services: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "Service",
          required: true,
        },
        qty: { type: Number, required: true, min: 1 },
      },
    ],
    default: [],
  },
  servicePackages: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "ServicePackage",
          required: true,
        },
        qty: { type: Number, required: true, min: 1 },
      },
    ],
    default: [],
  },
  tests: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "ParaClinicTest",
          required: true,
        },
        qty: { type: Number, required: true, min: 1 },
      },
    ],
    default: [],
  },
});

const Cart = mongoose.model("Cart", CartSchema);

export default Cart;
