import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IParaClinicTag } from "./ParaClinicTag";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { IInsurance } from "./Insurance";

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
  establishment?: string;
  businessTime?: string;
  phone?: string;
  onPremises: boolean;
  onlineResponse: boolean;
  basicInsurance: boolean;
  personelCount: number;
  summary?: string;
  insurances: IInsurance[];
  address?: string;
  averageScore: number;
  commentCount: number;
}

const ParaClinicSchema = new mongoose.Schema<IParaClinic, Model<IParaClinic>>(
  {
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
        {
          type: mongoose.Schema.ObjectId,
          ref: "ParaClinicTag",
          required: true,
        },
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
    establishment: { type: String },
    businessTime: { type: String },
    phone: { type: String },
    onPremises: { type: Boolean, default: false },
    basicInsurance: { type: Boolean, default: false },
    onlineResponse: { type: Boolean, default: false },
    personelCount: { type: Number, default: 0 },
    summary: { type: String },
    insurances: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
      ],
      default: [],
    },
    address: { type: String },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ParaClinicSchema.index({ location: "2dsphere" });

ParaClinicSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ParaClinicSchema.virtual("tests", {
  ref: "ParaClinicTest",
  localField: "_id",
  foreignField: "paraClinic",
});

const ParaClinic = mongoose.model("ParaClinic", ParaClinicSchema);

export default ParaClinic;
