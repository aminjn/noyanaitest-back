import { OpeningHours, openingHoursPlugin } from "../Lib/openingHours";
import { translatable } from "../Lib/i18n/translatable";
import { IProviderStatusFields, providerStatusPlugin } from "../Lib/providerStatus";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { CentreLicenceSchema, ICentreLicence } from "./CentreLicence";
import { IUser, MongoDoc } from "./User";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { centreLicenceLockPlugin } from "../Lib/centreLicenceLock";

export interface IPharmacy extends MongoDoc, IProviderStatusFields {
  user?: IUser;
  // the operating licence the staff verified: the verified tick
  // (Models/CentreLicence.ts, Lib/centreVerified.ts)
  licence?: ICentreLicence;
  // the licence number (the siam code of the approved request), set by
  // the staff only
  licenseNumber?: string;
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
  phone?: string;
  businessTime?: string;
  isRoundTheClock?: boolean;
  // structured weekly hours (2026-10, Lib/openingHours.ts); the free text
  // above is kept as a note
  openingHours?: OpeningHours;
  insurances?: mongoose.Types.ObjectId[];
  // where it ships cart orders (2026-10, Lib/delivery.ts deliveryAreaBlocks):
  // its own city only, its city plus the chosen cities / provinces, or the
  // whole country. Prescription-only items always ship within its own city.
  shippingScope?: ShippingScope;
  shipCities?: mongoose.Types.ObjectId[];
  shipProvinces?: mongoose.Types.ObjectId[];
  // verified buyer reviews (2026-10, Models/Comment.ts recalcResourceCommentStats):
  // the average of approved reviews and their count, as on ParaClinic
  averageScore: number;
  commentCount: number;
}

export const shippingScopes = ["city", "selected", "nationwide"] as const;
export type ShippingScope = (typeof shippingScopes)[number];

const PharmacySchema = new mongoose.Schema<IPharmacy, Model<IPharmacy>>({
  // written by the admin / the request approval only (Lib/centreVerified.ts)
  licence: { type: CentreLicenceSchema },
  licenseNumber: { type: String, trim: true, maxlength: 60 },
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
  // contact and hours shown on the public page (2026-10)
  phone: { type: String, trim: true },
  businessTime: { type: String, trim: true },
  isRoundTheClock: { type: Boolean, default: false },
  insurances: [{ type: mongoose.Schema.ObjectId, ref: "Insurance" }],
  // nationwide = how every pharmacy shipped before the setting existed
  shippingScope: { type: String, enum: shippingScopes, default: "nationwide" },
  shipCities: [{ type: mongoose.Schema.ObjectId, ref: "City" }],
  shipProvinces: [{ type: mongoose.Schema.ObjectId, ref: "Province" }],
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
});

PharmacySchema.plugin(translatable);

// the licence number and the licence record change only through the
// super admin's licence endpoint or a become-request's approval
// (Lib/centreLicenceLock.ts)
PharmacySchema.plugin(centreLicenceLockPlugin, { numberField: "licenseNumber" });
// structured opening hours and "open now", in step with isRoundTheClock
PharmacySchema.plugin(openingHoursPlugin, { roundTheClockField: "isRoundTheClock" });
// suspension by an admin, distinct from draft (Lib/providerStatus.ts)
PharmacySchema.plugin(providerStatusPlugin, { activeField: "active" });

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
PharmacySchema.plugin(geoFromPointPlugin, {
  modelName: "Pharmacy",
  fields: { province: "province", city: "city", district: "district" },
});

const Pharmacy = mongoose.model("Pharmacy", PharmacySchema);

export default Pharmacy;
