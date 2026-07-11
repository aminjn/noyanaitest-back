import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { IHospitalCategory } from "./HospitalCategory";
import { IHospitalTag } from "./HospitalTag";

export interface IHospital extends MongoDoc {
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
  image: { type: String };
}

const HospitalSchema = new mongoose.Schema<IHospital, Model<IHospital>>({
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
});

HospitalSchema.index({ location: "2dsphere" });

const Hospital = mongoose.model("Hospital", HospitalSchema);

export default Hospital;
