import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IHospital } from "./Hospital";
import { IHospitalDoctor } from "./HospitalDoctor";

export interface IHospitalDepartment extends MongoDoc {
  hospital: IHospital;
  name?: string;
  description?: string;
  image?: string;
  active: boolean;
  order: number;
  doctors: IHospitalDoctor[];
  doctorsCount: number;
  summary?: string;
  phone?: string;
}

const HospitalDepartmentSchema = new mongoose.Schema<
  IHospitalDepartment,
  Model<IHospitalDepartment>
>(
  {
    hospital: { type: mongoose.Schema.ObjectId, ref: "Hospital", required: true },
    // a department is listed by its name: a nameless one was a blank row
    name: { type: String, required: true, trim: true },
    description: { type: String },
    image: { type: String },
    active: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    summary: { type: String },
    phone: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

HospitalDepartmentSchema.virtual("doctors", {
  ref: "HospitalDoctor",
  localField: "_id",
  foreignField: "department",
});

HospitalDepartmentSchema.virtual("doctorsCount", {
  ref: "HospitalDoctor",
  localField: "_id",
  foreignField: "department",
  count: true,
});

HospitalDepartmentSchema.plugin(translatable);

const HospitalDepartment = mongoose.model(
  "HospitalDepartment",
  HospitalDepartmentSchema,
);

export default HospitalDepartment;
