import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// How cart orders are shipped (2026-09 owner decision), set from the super
// admin panel (/notadmin/deliverySettings):
//   origin and destination in the same city -> Tapsi courier, a flat fee
//     charged at checkout until the Tapsi API is connected
//   different cities -> Tipax, "pas-kerayeh": the buyer pays the courier on
//     delivery, nothing is charged on the site
// Origin is the pharmacy's city; a pharmacy with no city ships from
// `defaultOriginCity` (Tehran when unset).
export interface IDeliverySettings extends MongoDoc {
  singleton: "SINGLETON";
  tapsiFlatFee: number;
  defaultOriginCity?: mongoose.Types.ObjectId;
  // a sent Tipax parcel is confirmed delivered automatically this many days
  // after it was sent, unless the buyer reported a problem (2026-10,
  // Services/shipmentDeliveryService.ts)
  tipaxAutoConfirmDays: number;
  // the buyer's tracking link for a Tipax waybill; {code} is replaced by
  // the waybill number
  tipaxTrackingUrl?: string;
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt?: Date;
}

export const DEFAULT_TAPSI_FLAT_FEE = 100_000;
export const DEFAULT_TIPAX_AUTO_CONFIRM_DAYS = 7;
export const DEFAULT_TIPAX_TRACKING_URL = "https://tipaxco.com/tracking?code={code}";

const DeliverySettingsSchema = new mongoose.Schema<
  IDeliverySettings,
  Model<IDeliverySettings>
>({
  singleton: {
    type: String,
    enum: ["SINGLETON"],
    default: "SINGLETON",
    unique: true,
  },
  tapsiFlatFee: { type: Number, min: 0, default: DEFAULT_TAPSI_FLAT_FEE },
  defaultOriginCity: { type: mongoose.Schema.ObjectId, ref: "City" },
  tipaxAutoConfirmDays: {
    type: Number,
    min: 1,
    max: 30,
    default: DEFAULT_TIPAX_AUTO_CONFIRM_DAYS,
  },
  tipaxTrackingUrl: { type: String, trim: true, maxlength: 300 },
  updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  updatedAt: { type: Date },
});

const DeliverySettings = mongoose.model(
  "DeliverySettings",
  DeliverySettingsSchema,
);

export default DeliverySettings;
