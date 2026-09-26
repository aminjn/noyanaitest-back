import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProductSeller } from "./ProductSeller";
import { IProductPackage } from "./ProductPackage";
import { IService } from "./Service";
import { IServicePackage } from "./ServicePackage";
import { IParaClinicTest } from "./ParaClinicTest";
import { ITransaction } from "./Transaction";
import { IUserAddress } from "./UserAddress";

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

// wallet -> debited synchronously in CartController.submitCart
// sep    -> SEP (Saman) online gateway (2026-09): the order is created
//           "pending", the buyer is redirected to the bank, and
//           Services/paymentService.ts marks it "paid" once the payment is
//           verified (or "cancelled" if it fails / expires)
export const orderPaymentMethods = ["wallet", "sep"] as const;

export type OrderPaymentMethod = (typeof orderPaymentMethods)[number];

// paid      -> payment settled (synchronously for "wallet", after gateway
//              verification for "sep")
// pending   -> order exists but its gateway payment isn't confirmed yet -
//              sellers must NOT see these (their incoming-order queries
//              filter on status "paid")
// cancelled -> order was cancelled / its payment was reversed
export const orderStatuses = ["pending", "paid", "cancelled"] as const;

export type OrderStatus = (typeof orderStatuses)[number];

// Per-item fulfillment status (2026-08) - tracked separately from the
// order-level `status` above (which is about payment). Each seller
// (pharmacy/doctor/paraClinic) fulfills or cancels only its own line items
// within an order, since an order's item arrays can mix items from several
// different sellers. Defaults to "pending" until a seller acts on it.
export const orderItemStatuses = ["pending", "fulfilled", "cancelled"] as const;

export type OrderItemStatus = (typeof orderItemStatuses)[number];

// Every entry here is one SMS an order's own buyer or an involved seller
// org can receive about that specific order, sent via
// Services/orderSmsService.ts. Each gets its own dedicated SmsPatterns
// field (Models/SmsPatterns.ts derives one per entry via
// Lib/smsPatternName.ts's smsPatternNameForEvent, same convention as
// userAlertEvents/reservationSmsEvents) - unconditional transactional
// sends, not gated by a staff opt-in toggle.
//
// Only three seller-side events exist, not four: an order's items can only
// ever come from ProductSeller/ProductPackage (owned by a Pharmacy),
// Service/ServicePackage (owned by a DoctorProfile), or ParaClinicTest
// (owned by a ParaClinic) - see the `item`/owner refs below. Nothing a
// Clinic owns can appear as an order item today, so there is deliberately
// no `newOrderClinic` - flagged to the user rather than silently assumed,
// since they asked for one (2026-09).
export const orderSmsEvents = [
  "newOrderUser",
  "newOrderPharmacy",
  "newOrderDoctor",
  "newOrderParaClinic",
] as const;

export type OrderSmsEvent = (typeof orderSmsEvents)[number];

// Per-event SMS variable shapes - see Models/UserAlert.ts's
// UserAlertSmsVariables comment for why this is a specific shape per event
// rather than a generic {title,message} pair (2026-09 correction).
// `total`/subtotal amounts are formatted as plain digit strings by
// Services/orderSmsService.ts before being sent.
export type OrderSmsVariables = {
  newOrderUser: { orderId: string; total: string };
  newOrderPharmacy: { orderId: string; customerName: string };
  newOrderDoctor: { orderId: string; customerName: string };
  newOrderParaClinic: { orderId: string; customerName: string };
};

export interface IOrder extends MongoDoc {
  user: IUser;
  products: {
    item: IProductSeller;
    qty: number;
    price: number;
    status: OrderItemStatus;
  }[];
  productPackages: {
    item: IProductPackage;
    qty: number;
    price: number;
    status: OrderItemStatus;
  }[];
  services: {
    item: IService;
    qty: number;
    price: number;
    status: OrderItemStatus;
  }[];
  servicePackages: {
    item: IServicePackage;
    qty: number;
    price: number;
    status: OrderItemStatus;
  }[];
  tests: {
    item: IParaClinicTest;
    qty: number;
    price: number;
    status: OrderItemStatus;
  }[];
  // Sum of every line's (price - discount) * qty, with no tax added - what
  // the item prices alone add up to. `total` below is what the buyer is
  // actually charged (subtotal + tax); item prices themselves never change
  // because of tax (2026-09 user decision, see Lib/taxSettings.ts).
  subtotal: number;
  // Tax computed per line at submission time (each line's owning
  // pharmacy/doctor/paraClinic can have its own rate, see
  // Lib/taxSettings.ts), summed into one order-level amount for display.
  tax: number;
  total: number;
  paymentMethod: OrderPaymentMethod;
  status: OrderStatus;
  transaction?: ITransaction;
  // shipping/delivery address, snapshotted by reference at submission time -
  // only required when the order contains physical items (see
  // physicalOrderModels in CartController.submitCart)
  address?: IUserAddress;
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
        // per-item fulfillment status, set by the owning seller
        status: {
          type: String,
          enum: orderItemStatuses,
          default: "pending",
          required: true,
        },
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
        status: {
          type: String,
          enum: orderItemStatuses,
          default: "pending",
          required: true,
        },
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
        status: {
          type: String,
          enum: orderItemStatuses,
          default: "pending",
          required: true,
        },
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
        status: {
          type: String,
          enum: orderItemStatuses,
          default: "pending",
          required: true,
        },
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
        status: {
          type: String,
          enum: orderItemStatuses,
          default: "pending",
          required: true,
        },
      },
    ],
    default: [],
  },
  subtotal: { type: Number, required: true, min: 0 },
  tax: { type: Number, required: true, min: 0, default: 0 },
  total: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: orderPaymentMethods, required: true },
  status: {
    type: String,
    enum: orderStatuses,
    default: "paid",
    required: true,
  },
  transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  address: { type: mongoose.Schema.ObjectId, ref: "UserAddress" },
  submittedAt: { type: Date, default: () => new Date() },
  paidAt: { type: Date },
});

OrderSchema.index({ user: 1, submittedAt: -1 });

const Order = mongoose.model("Order", OrderSchema);

export default Order;
