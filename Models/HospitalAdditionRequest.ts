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

export interface IHospitalAdditionRequest extends MongoDoc {
  submittedAt: Date;
  status: AdditionRequestStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
  submittedBy: IDoctorProfile;
  hospitalName: string;
  hospitalAddress: string;
  ownerPhone: string;
  ownerName: string;
  province: Province;
  city: City;
  description?: string;
  createdNode?: mongoose.Types.ObjectId;
}

const HospitalAdditionRequestSchema = new mongoose.Schema<
  IHospitalAdditionRequest,
  Model<IHospitalAdditionRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  status: {
    type: String,
    enum: additionRequestStatuses,
    default: "Pending",
  },
  rejectReason: { type: String },
  decidedAt: { type: Date },
  submittedBy: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  hospitalName: { type: String, required: true },
  hospitalAddress: { type: String, required: true },
  ownerPhone: { type: String, required: true },
  ownerName: { type: String, required: true },
  province: { type: String, enum: provinceSlugs, required: true },
  city: { type: String, enum: citySlugs, required: true },
  description: { type: String },
  // the centre an admin created from this request (admin "create" action)
  createdNode: { type: mongoose.Schema.ObjectId },
});

const HospitalAdditionRequest = mongoose.model(
  "HospitalAdditionRequest",
  HospitalAdditionRequestSchema
);

export default HospitalAdditionRequest;
