import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IUserIdentity } from "./UserIdentity";
import { ITaminSpec } from "./TaminSpec";
import { ITaminComplaint } from "./TaminComplaint";
import { ITaminIcid } from "./TaminIdid";

export interface IReferralPrescription extends MongoDoc {
  author: IDoctorProfile;
  patient: IUserIdentity;
  spec: ITaminSpec;
  complaints: ITaminComplaint[];
  icds: ITaminIcid[];
  createdAt: Date;
  taminId: string;
  tracking: string;
  quantity: number;
  message: string;
  referralDate: Date;
}

const ReferralPrescriptionSchema = new mongoose.Schema<
  IReferralPrescription,
  Model<IReferralPrescription>
>({
  author: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  patient: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
  spec: { type: mongoose.Schema.ObjectId, ref: "TaminSpec", required: true },
  complaints: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "TaminComplaint", required: true },
    ],
    required: true,
  },
  icds: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "TaminIcid", required: true },
    ],
    required: true,
  },
  createdAt: { type: Date, default: () => new Date() },
  taminId: { type: String, required: true },
  tracking: { type: String, required: true },
  quantity: { type: Number },
  message: { type: String },
  referralDate: { type: Date },
});

const ReferralPrescription = mongoose.model(
  "ReferralPrescription",
  ReferralPrescriptionSchema,
);

export default ReferralPrescription;
