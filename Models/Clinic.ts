import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { IClinicDepartment } from "./ClinicDepatment";
import { IDoctor } from "./Doctor";
import { IClinicDoctor } from "./ClinicDoctor";
import { IClinicCategory } from "./ClinicCategory";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { IClinicTag } from "./ClinicTag";
import { IInsurance } from "./Insurance";

export interface IClinic extends MongoDoc {
  user?: IUser;
  slug?: string;
  name?: string;
  description?: string;
  address?: string;
  phone?: string;
  lat?: number;
  lng?: number;
  image?: string;
  order: number;
  active: boolean;
  departments: IClinicDepartment;
  doctors: IClinicDoctor[];
  location?: { type: "Point"; coordinates?: [number, number] };
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  summary?: string;
  category?: IClinicCategory;
  special: boolean;
  tags: IClinicTag[];
  isRoundTheClock: boolean;
  insurances: IInsurance[];
  clinicCode?: string;
  personelCount: number;
  establishment?: string;
  website?: string;
  mail?: string;
  businessTimes?: string;
  services: string[];
  certificates: string[];
}

const ClinicSchema = new mongoose.Schema<IClinic, Model<IClinic>>(
  {
    slug: { type: String, unique: true, sparse: true },
    name: { type: String },
    description: { type: String },
    address: { type: String },
    phone: { type: String },
    province: { type: mongoose.Schema.ObjectId, ref: "Province" },
    city: { type: mongoose.Schema.ObjectId, ref: "City" },
    district: { type: mongoose.Schema.ObjectId, ref: "District" },
    lat: { type: Number },
    lng: { type: Number },
    image: { type: String },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: false },
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      sparse: true,
      unique: true,
    },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    summary: { type: String },
    category: { type: mongoose.Schema.ObjectId, ref: "ClinicCategory" },
    special: { type: Boolean, default: false },
    tags: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "ClinicTag", required: true },
      ],
      default: [],
    },
    isRoundTheClock: { type: Boolean, default: false },
    insurances: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
      ],
      default: [],
    },
    clinicCode: { type: String },
    personelCount: { type: Number, default: 0 },
    establishment: { type: String },
    website: { type: String },
    mail: { type: String },
    businessTimes: { type: String },
    services: { type: [String], default: [] },
    certificates: { type: [String], default: [] },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ClinicSchema.virtual("departments", {
  ref: "ClinicDepartment",
  localField: "_id",
  foreignField: "clinic",
});

ClinicSchema.virtual("doctors", {
  ref: "ClinicDoctor",
  localField: "_id",
  foreignField: "clinic",
});

ClinicSchema.index({ location: "2dsphere" });

const Clinic = mongoose.model("Clinic", ClinicSchema);

export default Clinic;
