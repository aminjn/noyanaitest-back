import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  AdditionRequestStatus,
  additionRequestStatuses,
} from "./ClinicAdditionRequest";
import { IDoctorProfile } from "./DoctorProfile";

export interface IInsuranceAdditionRequest extends MongoDoc {
  submittedAt: Date;
  submittedBy: IDoctorProfile;
  status: AdditionRequestStatus;
  name: string;
  description?: string;
  createdNode?: mongoose.Types.ObjectId;
}

const InsuranceAdditionRequestSchema = new mongoose.Schema<
  IInsuranceAdditionRequest,
  Model<IInsuranceAdditionRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  submittedBy: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  status: {
    type: String,
    enum: additionRequestStatuses,
    default: "Pending",
  },
  name: { type: String, required: true },
  description: { type: String },
  // the centre an admin created from this request (admin "create" action)
  createdNode: { type: mongoose.Schema.ObjectId },
});

const InsuranceAdditionRequest = mongoose.model(
  "InsuranceAdditionRequest",
  InsuranceAdditionRequestSchema
);

export default InsuranceAdditionRequest;
