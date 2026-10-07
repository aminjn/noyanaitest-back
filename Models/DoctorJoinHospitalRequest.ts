import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IHospital } from "./Hospital";

// "Left" (2026-10): the membership the request led to has ended (the doctor
// left or the centre removed them). It is terminal like the others, so the
// doctor's list no longer shows "approved" for a centre they are not in;
// asking again reopens the same row (one row per doctor + centre).
export const doctorJoinProfileStatuses = ["Pending", "Approved", "Rejected", "Left"] as const;

type DoctorJoinProfileStatus = (typeof doctorJoinProfileStatuses)[number];

const joinHospitalSubmissionParties = ["DoctorProfile", "Hospital"] as const;

type JoinHospitalSubmissionParty = (typeof joinHospitalSubmissionParties)[number];

export interface IDoctorJoinHospitalRequest extends MongoDoc {
  status: DoctorJoinProfileStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
  submittedAt: Date;
  submissionParty: JoinHospitalSubmissionParty;
  doctor: IDoctorProfile;
  hospital: IHospital;
  statusLastChangedAt: Date;
  message?: string;
}

const DoctorJoinHospitalRequestSchema = new mongoose.Schema<
  IDoctorJoinHospitalRequest,
  Model<IDoctorJoinHospitalRequest>
>({
  status: { type: String, enum: doctorJoinProfileStatuses, default: "Pending" },
  rejectReason: { type: String },
  decidedAt: { type: Date },
  submittedAt: { type: Date, default: () => new Date() },
  submissionParty: {
    type: String,
    enum: joinHospitalSubmissionParties,
    required: true,
  },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  hospital: { type: mongoose.Schema.ObjectId, ref: "Hospital", required: true },
  statusLastChangedAt: { type: Date, default: () => new Date() },
  message: { type: String, trim: true },
});

DoctorJoinHospitalRequestSchema.index({ doctor: 1, hospital: 1 }, { unique: true });

const DoctorJoinHospitalRequest = mongoose.model(
  "DoctorJoinHospitalRequest",
  DoctorJoinHospitalRequestSchema
);

export default DoctorJoinHospitalRequest;
