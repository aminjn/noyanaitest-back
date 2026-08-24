import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProductSeller } from "./ProductSeller";
import { IProductPackage } from "./ProductPackage";
import { IService } from "./Service";
import { IServicePackage } from "./ServicePackage";
import { IParaClinicTest } from "./ParaClinicTest";
import { ITransaction } from "./Transaction";

// mirrors Cart's cartModels - kept separate (not imported from Cart.ts)
// since an order's items are a point-in-time snapshot, not a live cart
export const orderModels = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
] as const;

export type OrderModel = (typeof orderModels)[number];

// "wallet" is the only method wired up today (CartController.submitCart) -
// this enum grows as more payment methods are added later
export const orderPaymentMethods = ["wallet"] as const;

export type OrderPaymentMethod = (typeof orderPaymentMethods)[number];

// paid      -> payment settled at submission time (the only path today,
//              since a wallet debit happens synchronously in submitCart)
// pending   -> reserved for a future async payment method (e.g. a gateway
//              redirect) where the order exists before payment is confirmed
// cancelled -> order was cancelled / its payment was reversed
export const orderStatuses = ["pending", "paid", "cancelled"] as const;

export type OrderStatus = (typeof orderStatuses)[number];

export interface IOrder extends MongoDoc {
  user: IUser;
  products: { item: IProductSeller; qty: number; price: number }[];
  productPackages: { item: IProductPackage; qty: number; price: number }[];
  services: { item: IService; qty: number; price: number }[];
  servicePackages: { item: IServicePackage; qty: number; price: number }[];
  tests: { item: IParaClinicTest; qty: number; price: number }[];
  total: number;
  paymentMethod: OrderPaymentMethod;
  status: OrderStatus;
  transaction?: ITransaction;
  submittedAt: Date;
  paidAt?: Date;
}

const OrderSchema = new mongoose.Schema<IOrder, Model<IOrder>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  products: {
    type: [
      {
        item: {
          type: mongoose.Schema.ObjectId,
          ref: "ProductSeller",
          required: true,
        },
        qty: { type: Number, required: true },
        // unit price snapshotted at submission time (item price minus its
        // discount), so the order stays accurate even if the catalog item's
        // price changes later
        price: { type: Number, required: true },
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
        qty: { type: Number, required: true },
        price: { type: Number, required: true },
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
        qty: { type: Number, required: true },
        price: { type: Number, required: true },
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
        qty: { type: Number, required: true },
        price: { type: Number, required: true },
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
        qty: { type: Number, required: true },
        price: { type: Number, required: true },
      },
    ],
    default: [],
  },
  total: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: orderPaymentMethods, required: true },
  status: {
    type: String,
    enum: orderStatuses,
    default: "paid",
    required: true,
  },
  transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  submittedAt: { type: Date, default: () => new Date() },
  paidAt: { type: Date },
});

OrderSchema.index({ user: 1, submittedAt: -1 });

const Order = mongoose.model("Order", OrderSchema);

export default Order;
