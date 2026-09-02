import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IOrder } from "./Order";
import { IPharmacy } from "./Pharmacy";

// A Snapp Box courier ride dispatched for one pharmacy's line items within
// an Order (2026-09) - see pharmacyController.dispatchOrderDelivery /
// Lib/snappClient.ts. One order can have several DeliveryRide docs if it
// mixes items from several pharmacies, since each pharmacy ships from its
// own location and dispatches its own courier independently.
export interface IDeliveryRide extends MongoDoc {
  order: IOrder;
  pharmacy: IPharmacy;
  // Snapp's HRI (Human Readable ID) - every other Snapp ride call
  // (refresh/status/cancel) is addressed by this string, not a numeric id.
  hri: string;
  // last known current_state from Snapp (see snappClient.snappRideStates) -
  // refreshed on demand via getOrderDeliveryStatus, not pushed by Snapp.
  currentState?: number;
  finalPrice?: number;
  driverName?: string;
  driverCellphone?: string;
  shareUrl?: string;
  requestedAt: Date;
  lastRefreshedAt?: Date;
  cancelledAt?: Date;
}

const DeliveryRideSchema = new mongoose.Schema<
  IDeliveryRide,
  Model<IDeliveryRide>
>({
  order: { type: mongoose.Schema.ObjectId, ref: "Order", required: true },
  pharmacy: {
    type: mongoose.Schema.ObjectId,
    ref: "Pharmacy",
    required: true,
  },
  hri: { type: String, required: true, unique: true },
  currentState: { type: Number },
  finalPrice: { type: Number },
  driverName: { type: String },
  driverCellphone: { type: String },
  shareUrl: { type: String },
  requestedAt: { type: Date, default: () => new Date() },
  lastRefreshedAt: { type: Date },
  cancelledAt: { type: Date },
});

DeliveryRideSchema.index({ order: 1, pharmacy: 1 });

const DeliveryRide = mongoose.model("DeliveryRide", DeliveryRideSchema);

export default DeliveryRide;
