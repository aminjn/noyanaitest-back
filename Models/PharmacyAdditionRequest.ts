import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import {
  AdditionRequestStatus,
  additionRequestStatuses,
} from "./ClinicAdditionRequest";

export interface IPharmacyAdditionRequest extends MongoDoc {
  submittedAt: Date;
  submittedBy: IDoctorProfile;
  name: string;
  address: string;
  province: Province;
  city: City;
  description?: string;
  createdNode?: mongoose.Types.ObjectId;
  status: AdditionRequestStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
}

const PharmacyAdditionRequestSchema = new mongoose.Schema<
  IPharmacyAdditionRequest,
  Model<IPharmacyAdditionRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  submittedBy: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  name: { type: String, required: true },
  address: { type: String, required: true },
  province: { type: String, enum: provinceSlugs, required: true },
  city: { type: String, enum: citySlugs, required: true },
  description: { type: String },
  // the centre an admin created from this request (admin "create" action)
  createdNode: { type: mongoose.Schema.ObjectId },
  status: {
    type: String,
    enum: additionRequestStatuses,
    default: "Pending",
  },
  rejectReason: { type: String },
  decidedAt: { type: Date },
});

const PharmacyAdditionRequest = mongoose.model(
  "PharmacyAdditionRequest",
  PharmacyAdditionRequestSchema
);

export default PharmacyAdditionRequest;
