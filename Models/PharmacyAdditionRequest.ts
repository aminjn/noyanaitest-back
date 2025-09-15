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
  status: AdditionRequestStatus;
}

const PharmacyAdditionRequestSchema = new mongoose.Schema<
  IPharmacyAdditionRequest,
  Model<IPharmacyAdditionRequest>
>({
  submittedAt: { type: Date },
  submittedBy: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  name: { type: String, required: true },
  address: { type: String, required: true },
  province: { type: String, enum: provinceSlugs, required: true },
  city: { type: String, enum: citySlugs, required: true },
  description: { type: String },
  status: {
    type: String,
    enum: additionRequestStatuses,
    default: "Pending",
  },
});

const PharmacyAdditionRequest = mongoose.model(
  "PharmacyAdditionRequest",
  PharmacyAdditionRequestSchema
);

export default PharmacyAdditionRequest;
