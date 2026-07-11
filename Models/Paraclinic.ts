import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IParaClinicTag } from "./ParaClinicTag";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";

export interface IParaClinic extends MongoDoc {
  user?: IUser;
  name?: string;
  order: number;
  active: boolean;
  tags: IParaClinicTag[];
  location?: { type: "Point"; coordinates?: [number, number] };
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  special: boolean;
  image?: string;
  slug?: string;
}

const ParaClinicSchema = new mongoose.Schema<IParaClinic, Model<IParaClinic>>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    unique: true,
    sparse: true,
  },
  name: { type: String },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
  tags: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "ParaClinicTag", required: true },
    ],
    default: [],
  },
  province: { type: mongoose.Schema.ObjectId, ref: "Province" },
  city: { type: mongoose.Schema.ObjectId, ref: "City" },
  district: { type: mongoose.Schema.ObjectId, ref: "District" },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
  special: { type: Boolean, default: false },
  image: { type: String },
  slug: { type: String, unique: true, sparse: true },
});

ParaClinicSchema.index({ location: "2dsphere" });

const ParaClinic = mongoose.model("ParaClinic", ParaClinicSchema);

export default ParaClinic;
