import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IDoctorSecretaryAccessLevel } from "./DoctorSecretaryAccessLevel";

const doctorSecretaryRequestStatuses = [
  "Pending",
  "Approved",
  "Rejected",
] as const;

type DoctorSecretaryRequestStatus =
  (typeof doctorSecretaryRequestStatuses)[number];

export interface IDoctorSecretaryRequest extends MongoDoc {
  submittedAt: Date;
  doctor: IDoctorProfile;
  accessLevel?: IDoctorSecretaryAccessLevel;
  phone: string;
  status: DoctorSecretaryRequestStatus;
  displayName?: string;
  message?: string;
}

const DoctorSecretaryRequestSchema = new mongoose.Schema<
  IDoctorSecretaryRequest,
  Model<IDoctorSecretaryRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  accessLevel: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorSecretaryAccessLevel",
  },
  phone: { type: String, required: true },
  status: {
    type: String,
    default: "Pending",
    enum: doctorSecretaryRequestStatuses,
  },
  displayName: { type: String, trim: true },
  message: { type: String, trim: true },
});

const DoctorSecretaryRequest = mongoose.model(
  "DoctorSecretaryRequest",
  DoctorSecretaryRequestSchema
);

export default DoctorSecretaryRequest;
