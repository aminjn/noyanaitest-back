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
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt?: Date;
}

export const DEFAULT_TAPSI_FLAT_FEE = 100_000;

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
  updatedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  updatedAt: { type: Date },
});

const DeliverySettings = mongoose.model(
  "DeliverySettings",
  DeliverySettingsSchema,
);

export default DeliverySettings;
