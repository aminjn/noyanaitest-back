import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { IClinicDepartment } from "./ClinicDepatment";
import { IDoctor } from "./Doctor";
import { IClinicDoctor } from "./ClinicDoctor";

export interface IClinic extends MongoDoc {
  user?: IUser;
  slug?: string;
  name?: string;
  description?: string;
  address?: string;
  phone?: string;
  province?: Province;
  city?: City;
  lat?: number;
  lng?: number;
  image?: string;
  order: number;
  active: boolean;
  departments: IClinicDepartment;
  doctors: IClinicDoctor[];
}

const ClinicSchema = new mongoose.Schema<IClinic, Model<IClinic>>(
  {
    slug: { type: String, unique: true, sparse: true },
    name: { type: String },
    description: { type: String },
    address: { type: String },
    phone: { type: String },
    province: { type: String, enum: provinceSlugs },
    city: { type: String, enum: citySlugs },
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

const Clinic = mongoose.model("Clinic", ClinicSchema);

export default Clinic;
