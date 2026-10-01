import mongoose, { Model } from "mongoose";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import { IUser, MongoDoc } from "./User";
import { ICity } from "./Geo/City";

export interface IUserAddress extends MongoDoc {
  user: IUser;
  displayName: string;
  address: string;
  // who the courier calls; defaults to the account's own phone
  receiverPhone?: string;
  postalCode?: string;
  // decides the courier: same city as the pharmacy -> Tapsi, else Tipax
  // (Lib/delivery.ts); older addresses fall back to the map pin
  city?: ICity;
  location?: { type: "Point"; coordinates?: [number, number] };
  // soft delete: orders keep a reference to the address they shipped to,
  // so a removed address is hidden instead of deleted
  archived?: boolean;
}

const UserAddressSchema = new mongoose.Schema<
  IUserAddress,
  Model<IUserAddress>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  displayName: { type: String, required: true },
  address: { type: String, required: true },
  receiverPhone: { type: String },
  postalCode: { type: String },
  city: { type: mongoose.Schema.ObjectId, ref: "City" },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
  archived: { type: Boolean, default: false },
});

UserAddressSchema.index({ location: "2dsphere" });

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
UserAddressSchema.plugin(geoFromPointPlugin, {
  modelName: "UserAddress",
  fields: { city: "city" },
});

const UserAddress = mongoose.model("UserAddress", UserAddressSchema);

export default UserAddress;
