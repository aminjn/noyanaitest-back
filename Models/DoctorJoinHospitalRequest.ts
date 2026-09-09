import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IHospital } from "./Hospital";

const doctorJoinProfileStatuses = ["Pending", "Approved", "Rejected"] as const;

type DoctorJoinProfileStatus = (typeof doctorJoinProfileStatuses)[number];

const joinHospitalSubmissionParties = ["DoctorProfile", "Hospital"] as const;

type JoinHospitalSubmissionParty = (typeof joinHospitalSubmissionParties)[number];

export interface IDoctorJoinHospitalRequest extends MongoDoc {
  status: DoctorJoinProfileStatus;
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
