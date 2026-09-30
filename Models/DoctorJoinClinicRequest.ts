import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IClinic } from "./Clinic";

const doctorJoinProfileStatuses = ["Pending", "Approved", "Rejected"] as const;

type DoctorJoinProfileStatus = (typeof doctorJoinProfileStatuses)[number];

const joinClinicSubmissionParties = ["DoctorProfile", "Clinic"] as const;

type JoinClinicSubmissionParty = (typeof joinClinicSubmissionParties)[number];

export interface IDoctorJoinClinicRequest extends MongoDoc {
  status: DoctorJoinProfileStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
  submittedAt: Date;
  submissionParty: JoinClinicSubmissionParty;
  doctor: IDoctorProfile;
  clinic: IClinic;
  statusLastChangedAt: Date;
  message?: string;
}

const DoctorJoinClinicRequestSchema = new mongoose.Schema<
  IDoctorJoinClinicRequest,
  Model<IDoctorJoinClinicRequest>
>({
  status: { type: String, enum: doctorJoinProfileStatuses, default: "Pending" },
  rejectReason: { type: String },
  decidedAt: { type: Date },
  submittedAt: { type: Date, default: () => new Date() },
  submissionParty: {
    type: String,
    enum: joinClinicSubmissionParties,
    required: true,
  },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  clinic: { type: mongoose.Schema.ObjectId, ref: "Clinic", required: true },
  statusLastChangedAt: { type: Date, default: () => new Date() },
  message: { type: String, trim: true },
});

DoctorJoinClinicRequestSchema.index({ doctor: 1, clinic: 1 }, { unique: true });

const DoctorJoinClinicRequest = mongoose.model(
  "DoctorJoinClinicRequest",
  DoctorJoinClinicRequestSchema
);

export default DoctorJoinClinicRequest;
