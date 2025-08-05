import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";
import { IClinicDoctor } from "./ClinicDoctor";

export interface IClinicDepartment extends MongoDoc {
  clinic: IClinic;
  name?: string;
  description?: string;
  image?: string;
  active: boolean;
  order: number;
  doctors: IClinicDoctor[];
  doctorsCount: number;
}

const ClinicDepartmentSchema = new mongoose.Schema<
  IClinicDepartment,
  Model<IClinicDepartment>
>(
  {
    clinic: { type: mongoose.Schema.ObjectId, ref: "Clinic", required: true },
    name: { type: String },
    description: { type: String },
    image: { type: String },
    active: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

ClinicDepartmentSchema.virtual("doctors", {
  ref: "ClinicDoctor",
  localField: "_id",
  foreignField: "department",
});

ClinicDepartmentSchema.virtual("doctorsCount", {
  ref: "ClinicDoctor",
  localField: "_id",
  foreignField: "department",
  count: true,
});

const ClinicDepartment = mongoose.model(
  "ClinicDepartment",
  ClinicDepartmentSchema
);

export default ClinicDepartment;
