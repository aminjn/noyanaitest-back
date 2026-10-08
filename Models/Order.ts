import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProductSeller } from "./ProductSeller";
import { IProductPackage } from "./ProductPackage";
import { IService } from "./Service";
import { IServicePackage } from "./ServicePackage";
import { IParaClinicTest } from "./ParaClinicTest";
import { ITransaction } from "./Transaction";
import { IUserAddress } from "./UserAddress";
import { DeliveryMethod, deliveryMethods } from "../Lib/delivery";
import {
  IOrderLinePrescription,
  orderLinePrescriptionSchema,
} from "../Lib/rxPrescription";

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

// Why a line was cancelled by the platform rather than by a person
// (Services/orderSettlementService.ts):
//   noResponse   -> the seller never answered (no accept / Rx review / lab
//                   result / shipment) before the line's `respondBy`
//                   deadline (Lib/orderResponse.ts, owner decision 2026-10:
//                   24 h pharmacy, 72 h lab, admin-configurable)
//   notFulfilled -> the seller answered but never finished the line within
//                   the 7-day stale-line window
export const orderLineAutoCancels = ["noResponse", "notFulfilled"] as const;
export type OrderLineAutoCancel = (typeof orderLineAutoCancels)[number];

// who confirmed a Tipax shipment delivered (Services/shipmentDeliveryService.ts)
export const shipmentDeliveredBys = ["buyer", "auto", "support", "migration"] as const;
export type ShipmentDeliveredBy = (typeof shipmentDeliveredBys)[number];

// Seller-response SLA fields of a pharmacy / lab line (2026-10). Doctor
// service lines have no SLA (they keep only the 7-day stale sweep).
//   respondBy        -> stamped when the order is paid: paidAt + the
//                       pharmacy / lab response hours
//   acceptedAt       -> the seller's first answer: "accept", an approved
//                       prescription, an uploaded lab result or a shipment
//                       sent. Fulfilling or cancelling also ends the wait.
//   responseWarnedAt -> the "deadline is near" notice went to the seller
//                       (set atomically, so it is sent once)
export interface IOrderLineResponse {
  respondBy?: Date;
  acceptedAt?: Date;
  responseWarnedAt?: Date;
}

export interface IOrderLineAutoCancel {
  autoCancel?: OrderLineAutoCancel;
  autoCancelledAt?: Date;
}

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
  products: ({
    item: IProductSeller;
    qty: number;
    price: number;
    tax?: number;
    status: OrderItemStatus;
    // prescription-only item (2026-10, Lib/rxPrescription.ts): snapshotted
    // at checkout with the prescription the buyer gave; the pharmacy must
    // approve it before the line can be fulfilled
    requiresPrescription?: boolean;
    prescription?: IOrderLinePrescription;
  } & IOrderLineResponse & IOrderLineAutoCancel)[];
  productPackages: ({
    item: IProductPackage;
    qty: number;
    price: number;
    tax?: number;
    status: OrderItemStatus;
    requiresPrescription?: boolean;
    prescription?: IOrderLinePrescription;
  } & IOrderLineResponse & IOrderLineAutoCancel)[];
  services: ({
    item: IService;
    qty: number;
    price: number;
    tax?: number;
    status: OrderItemStatus;
  } & IOrderLineAutoCancel)[];
  servicePackages: ({
    item: IServicePackage;
    qty: number;
    price: number;
    tax?: number;
    status: OrderItemStatus;
  } & IOrderLineAutoCancel)[];
  tests: ({
    item: IParaClinicTest;
    qty: number;
    price: number;
    tax?: number;
    status: OrderItemStatus;
    // the lab's answer (2026-10): result files (UserFile, private) and a note
    result?: { files: mongoose.Types.ObjectId[]; note?: string; uploadedAt?: Date };
    // the sampling appointment this line needs (2026-10, Lib/labSampling.ts)
    // and its start, snapshotted for the response / stale sweeps
    sampling?: mongoose.Types.ObjectId;
    samplingAt?: Date;
  } & IOrderLineResponse & IOrderLineAutoCancel)[];
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
  // one per pharmacy with physical items (Lib/delivery.ts): Tapsi for the
  // same city (its flat fee is in `total`), Tipax pay-on-delivery otherwise
  shipments: {
    _id: mongoose.Types.ObjectId;
    pharmacy: mongoose.Types.ObjectId;
    method: DeliveryMethod;
    fee: number;
    // the part of `fee` the platform pays for a «پرو» member (2026-10): the
    // buyer paid fee - proDiscount, the pharmacy is still credited `fee`
    proDiscount?: number;
    payOnDelivery: boolean;
    originCity?: mongoose.Types.ObjectId;
    destinationCity?: mongoose.Types.ObjectId;
    // the seller marks its part sent (2026-10): the courier link or ride
    // code, or the Tipax waybill number, shown to the buyer
    trackingCode?: string;
    shippedAt?: Date;
    // Tipax delivery (2026-10, Services/shipmentDeliveryService.ts): an
    // inter-city parcel counts as delivered only once confirmed - by the
    // buyer («تحویل گرفتم»), automatically at `confirmBy` (sent + the admin's
    // auto-confirm days) unless the buyer reported a problem, or by support.
    // Only then is the pharmacy paid (its settlement hold starts) and the
    // buyer asked to rate it. sent -> delivered | returned, one way.
    confirmBy?: Date;
    deliveredAt?: Date;
    deliveredBy?: ShipmentDeliveredBy;
    // the buyer said it did not arrive: a support ticket is opened and the
    // auto-confirm is paused until the buyer or support settles it
    problem?: { reportedAt: Date; note?: string; ticket?: mongoose.Types.ObjectId };
    // support: lost or returned to the pharmacy - its lines were refunded
    returnedAt?: Date;
  }[];
  // sum of the shipments' fees, included in `total` (less their «پرو»
  // discounts: what the buyer paid for delivery)
  deliveryFee: number;
  // the «پرو» discount on delivery the platform paid (sum of
  // shipments[].proDiscount)
  proDeliveryDiscount?: number;
  // home-sampling fees of the order's lab appointments (2026-10,
  // Lib/labSampling.ts), included in `total`
  samplingFee?: number;
  paymentMethod: OrderPaymentMethod;
  status: OrderStatus;
  transaction?: ITransaction;
  // shipping/delivery address, snapshotted by reference at submission time -
  // only required when the order contains physical items (see
  // physicalOrderModels in CartController.submitCart)
  address?: IUserAddress;
  submittedAt: Date;
  paidAt?: Date;
  // super admin interventions (2026-10, Finance > order detail): cancelling
  // the order or a line, forcing a stuck line's status - each with its
  // written reason, so the order itself tells what was done and why
  // sellers (Pharmacy / ParaClinic ids) whose buyer was already asked to
  // rate them for this order (2026-10, Services/orderSettlementService.ts
  // inviteSellerReview) - claimed atomically, so the ask goes out once
  reviewInvites?: mongoose.Types.ObjectId[];
  adminNotes?: {
    // rescheduleSampling / cancelSampling: a lab sampling appointment of the
    // order (2026-10, Lib/labSampling.ts); `line` is the appointment's id
    // confirmDelivery / returnShipment: a Tipax shipment of the order
    // (2026-10); `line` is the shipment's id
    action:
      | "cancelOrder"
      | "cancelLine"
      | "fulfillLine"
      | "rescheduleSampling"
      | "cancelSampling"
      | "confirmDelivery"
      | "returnShipment";
    model?: string;
    line?: mongoose.Types.ObjectId;
    reason: string;
    by?: mongoose.Types.ObjectId;
    at: Date;
  }[];
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
        qty: { type: Number, required: true, min: 1 },
        // unit price snapshotted at submission time (item price minus its
        // discount), so the order stays accurate even if the catalog item's
        // price changes later
        price: { type: Number, required: true },
        // this line's tax, snapshotted with the price (its seller's rate) -
        // what goes back to the buyer if the line is cancelled
        tax: { type: Number, min: 0 },
        requiresPrescription: { type: Boolean },
        prescription: { type: orderLinePrescriptionSchema },
        // per-item fulfillment status, set by the owning seller
        // seller-response SLA (2026-10, see IOrderLineResponse)
        respondBy: { type: Date },
        acceptedAt: { type: Date },
        responseWarnedAt: { type: Date },
        autoCancel: { type: String, enum: orderLineAutoCancels },
        autoCancelledAt: { type: Date },
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
        qty: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        // this line's tax, snapshotted with the price (its seller's rate) -
        // what goes back to the buyer if the line is cancelled
        tax: { type: Number, min: 0 },
        requiresPrescription: { type: Boolean },
        prescription: { type: orderLinePrescriptionSchema },
        // seller-response SLA (2026-10, see IOrderLineResponse)
        respondBy: { type: Date },
        acceptedAt: { type: Date },
        responseWarnedAt: { type: Date },
        autoCancel: { type: String, enum: orderLineAutoCancels },
        autoCancelledAt: { type: Date },
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
        qty: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        // this line's tax, snapshotted with the price (its seller's rate) -
        // what goes back to the buyer if the line is cancelled
        tax: { type: Number, min: 0 },
        autoCancel: { type: String, enum: orderLineAutoCancels },
        autoCancelledAt: { type: Date },
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
        qty: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        // this line's tax, snapshotted with the price (its seller's rate) -
        // what goes back to the buyer if the line is cancelled
        tax: { type: Number, min: 0 },
        autoCancel: { type: String, enum: orderLineAutoCancels },
        autoCancelledAt: { type: Date },
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
        qty: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        // this line's tax, snapshotted with the price (its seller's rate) -
        // what goes back to the buyer if the line is cancelled
        tax: { type: Number, min: 0 },
        result: {
          files: [{ type: mongoose.Schema.ObjectId, ref: "UserFile" }],
          note: { type: String, trim: true, maxlength: 2000 },
          uploadedAt: { type: Date },
        },
        // sampling appointment (2026-10, Models/LabSampling.ts)
        sampling: { type: mongoose.Schema.ObjectId, ref: "LabSampling" },
        samplingAt: { type: Date },
        // seller-response SLA (2026-10, see IOrderLineResponse)
        respondBy: { type: Date },
        acceptedAt: { type: Date },
        responseWarnedAt: { type: Date },
        autoCancel: { type: String, enum: orderLineAutoCancels },
        autoCancelledAt: { type: Date },
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
  shipments: {
    type: [
      {
        pharmacy: { type: mongoose.Schema.ObjectId, ref: "Pharmacy", required: true },
        method: { type: String, enum: deliveryMethods, required: true },
        fee: { type: Number, min: 0, default: 0 },
        proDiscount: { type: Number, min: 0, default: 0 },
        payOnDelivery: { type: Boolean, default: false },
        originCity: { type: mongoose.Schema.ObjectId, ref: "City" },
        destinationCity: { type: mongoose.Schema.ObjectId, ref: "City" },
        trackingCode: { type: String, trim: true, maxlength: 200 },
        shippedAt: { type: Date },
        confirmBy: { type: Date },
        deliveredAt: { type: Date },
        deliveredBy: { type: String, enum: shipmentDeliveredBys },
        problem: {
          type: new mongoose.Schema(
            {
              reportedAt: { type: Date, required: true },
              note: { type: String, trim: true, maxlength: 1000 },
              ticket: { type: mongoose.Schema.ObjectId, ref: "Ticket" },
            },
            { _id: false },
          ),
          default: undefined,
        },
        returnedAt: { type: Date },
      },
    ],
    default: [],
  },
  deliveryFee: { type: Number, min: 0, default: 0 },
  proDeliveryDiscount: { type: Number, min: 0, default: 0 },
  samplingFee: { type: Number, min: 0, default: 0 },
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
  adminNotes: {
    type: [
      {
        action: {
          type: String,
          enum: [
            "cancelOrder",
            "cancelLine",
            "fulfillLine",
            "rescheduleSampling",
            "cancelSampling",
            "confirmDelivery",
            "returnShipment",
          ],
          required: true,
        },
        model: { type: String },
        line: { type: mongoose.Schema.ObjectId },
        reason: { type: String, required: true, trim: true, maxlength: 1000 },
        by: { type: mongoose.Schema.ObjectId, ref: "User" },
        at: { type: Date, default: () => new Date() },
      },
    ],
    default: undefined,
  },
  reviewInvites: { type: [{ type: mongoose.Schema.ObjectId }], default: undefined },
});

OrderSchema.index({ user: 1, submittedAt: -1 });
// the seller-response sweep (Services/orderSettlementService.ts
// runOrderResponseSweep) looks lines up by their deadline
OrderSchema.index({ "products.respondBy": 1 }, { sparse: true });
OrderSchema.index({ "productPackages.respondBy": 1 }, { sparse: true });
OrderSchema.index({ "tests.respondBy": 1 }, { sparse: true });
// the Tipax auto-confirm sweep (Services/shipmentDeliveryService.ts)
OrderSchema.index({ "shipments.confirmBy": 1 }, { sparse: true });

const Order = mongoose.model("Order", OrderSchema);

export default Order;
