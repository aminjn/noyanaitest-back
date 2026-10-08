import { OpeningHours, openingHoursPlugin } from "../Lib/openingHours";
import { translatable } from "../Lib/i18n/translatable";
import { IProviderStatusFields, providerStatusPlugin } from "../Lib/providerStatus";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { IHospitalCategory } from "./HospitalCategory";
import { IHospitalTag } from "./HospitalTag";
import { IDoctorProfile } from "./DoctorProfile";
import { IHospitalClinic } from "./HospitalClinic";
import { IInsurance } from "./Insurance";
import { IHospitalDepartment } from "./HospitalDepartment";
import { IHospitalDoctor } from "./HospitalDoctor";

export interface IHospital extends MongoDoc, IProviderStatusFields {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  location?: { type: "Point"; coordinates?: [number, number] };
  isRoundTheClock: boolean;
  bedCount: number;
  category?: IHospitalCategory;
  tags: IHospitalTag[];
  special: boolean;
  image?: String;
  code?: string;
  establishment?: string;
  personelCount?: number;
  summary?: string;
  address?: string;
  businessTimes?: string;
  // structured weekly hours (2026-10, Lib/openingHours.ts); the free text
  // above is kept as a note
  openingHours?: OpeningHours;
  mail?: string;
  owner?: IDoctorProfile;
  phone?: string;
  website?: string;
  clinics: IHospitalClinic[];
  services: string[];
  insurances: IInsurance[];
  certificates: string[];
  averageScore: number;
  commentCount: number;
  // Org-account fields (2026-09), mirroring Models/Clinic.ts - lets a
  // hospital have its own login/panel (hospitalController/hospitalRouter),
  // departments and doctors of its own (separate from the `clinics` grouping
  // above, which links this hospital to independently-run Clinic docs via
  // HospitalClinic).
  user?: IUser;
  departments: IHospitalDepartment[];
  doctors: IHospitalDoctor[];
}

const HospitalSchema = new mongoose.Schema<IHospital, Model<IHospital>>(
  {
    name: { type: String },
    slug: { type: String, unique: true, sparse: true },
    isActive: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    province: { type: mongoose.Schema.ObjectId, ref: "Province" },
    city: { type: mongoose.Schema.ObjectId, ref: "City" },
    district: { type: mongoose.Schema.ObjectId, ref: "District" },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    isRoundTheClock: { type: Boolean, default: false },
    bedCount: { type: Number, default: 0 },
    category: { type: mongoose.Schema.ObjectId, ref: "HospitalCategory" },
    tags: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "HospitalTag", required: true },
      ],
      default: [],
    },
    special: { type: Boolean, default: false },
    image: { type: String },
    code: { type: String },
    establishment: { type: String },
    personelCount: { type: Number, min: 0 },
    summary: { type: String },
    address: { type: String },
    businessTimes: { type: String },
    mail: { type: String },
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      unique: true,
      sparse: true,
    },
    phone: { type: String },
    website: { type: String },
    services: { type: [String], default: [] },
    insurances: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
      ],
      default: [],
    },
    certificates: { type: [String], default: [] },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    // the owner. Not unique (2026-10): one account can own several clinics
    // and hospitals, the panel works on the one chosen in the centre
    // switcher (Lib/activeCentre.ts); Lib/migrateMultiCentreOwners.ts drops
    // the old unique index
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

HospitalSchema.index({ location: "2dsphere" });

HospitalSchema.virtual("clinics", {
  ref: "HospitalClinic",
  localField: "_id",
  foreignField: "hospital",
});

HospitalSchema.virtual("departments", {
  ref: "HospitalDepartment",
  localField: "_id",
  foreignField: "hospital",
});

HospitalSchema.virtual("doctors", {
  ref: "HospitalDoctor",
  localField: "_id",
  foreignField: "hospital",
});

HospitalSchema.plugin(translatable);
// structured opening hours and "open now", in step with isRoundTheClock
HospitalSchema.plugin(openingHoursPlugin, { roundTheClockField: "isRoundTheClock" });
// suspension by an admin, distinct from draft (Lib/providerStatus.ts)
HospitalSchema.plugin(providerStatusPlugin, { activeField: "isActive" });

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
HospitalSchema.plugin(geoFromPointPlugin, {
  modelName: "Hospital",
  fields: { province: "province", city: "city", district: "district" },
});

const Hospital = mongoose.model("Hospital", HospitalSchema);

export default Hospital;
