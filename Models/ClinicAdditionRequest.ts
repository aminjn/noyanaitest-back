import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { IDoctorProfile } from "./DoctorProfile";

export const additionRequestStatuses = [
  "Pending",
  "Proccessing",
  "Done",
  "Rejected",
] as const;

export type AdditionRequestStatus = (typeof additionRequestStatuses)[number];

export interface IClinicAdditionRequest extends MongoDoc {
  submittedAt: Date;
  status: AdditionRequestStatus;
  submittedBy: IDoctorProfile;
  clinicName: string;
  clinicAddress: string;
  ownerPhone: string;
  ownerName: string;
  province: Province;
  city: City;
  description?: string;
}

const ClinicAdditionRequestSchema = new mongoose.Schema<
  IClinicAdditionRequest,
  Model<IClinicAdditionRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  status: {
    type: String,
    enum: additionRequestStatuses,
    default: "Pending",
  },
  submittedBy: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  clinicName: { type: String, required: true },
  clinicAddress: { type: String, required: true },
  ownerPhone: { type: String, required: true },
  ownerName: { type: String, required: true },
  province: { type: String, enum: provinceSlugs, required: true },
  city: { type: String, enum: citySlugs, required: true },
  description: { type: String },
});

const ClinicAdditionRequest = mongoose.model(
  "ClinicAdditionRequest",
  ClinicAdditionRequestSchema
);

export default ClinicAdditionRequest;
