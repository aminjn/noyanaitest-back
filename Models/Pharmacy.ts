import { translatable } from "../Lib/i18n/translatable";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";

export interface IPharmacy extends MongoDoc {
  user?: IUser;
  name?: string;
  order: number;
  active: boolean;
  location?: { type: "Point"; coordinates?: [number, number] };
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  avatar?: string;
  summary?: string;
  slug?: string;
  address?: string;
  banner?: string;
}

const PharmacySchema = new mongoose.Schema<IPharmacy, Model<IPharmacy>>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    unique: true,
    sparse: true,
  },
  name: { type: String },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
  province: { type: mongoose.Schema.ObjectId, ref: "Province" },
  city: { type: mongoose.Schema.ObjectId, ref: "City" },
  district: { type: mongoose.Schema.ObjectId, ref: "District" },
  avatar: { type: String },
  summary: { type: String },
  slug: { type: String, unique: true, sparse: true },
  address: { type: String },
  banner: { type: String },
});

PharmacySchema.plugin(translatable);

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
PharmacySchema.plugin(geoFromPointPlugin, {
  modelName: "Pharmacy",
  fields: { province: "province", city: "city", district: "district" },
});

const Pharmacy = mongoose.model("Pharmacy", PharmacySchema);

export default Pharmacy;
