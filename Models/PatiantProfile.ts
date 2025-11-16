import mongoose, { Model } from "mongoose";
import { IUser } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IPatientProfileRecord } from "./PatientProfileRecord";

export interface IPatientProfile {
  user: IUser;
  doctor: IDoctorProfile;
  createdAt: Date;
  title: string;
  description?: string;
  diagnosis?: string;
  records?: IPatientProfileRecord[];
}

const PatientProfileSchema = new mongoose.Schema<
  IPatientProfile,
  Model<IPatientProfile>
>(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    doctor: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    createdAt: { type: Date, default: () => new Date() },
    title: { type: String, required: true },
    description: { type: String },
    diagnosis: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

PatientProfileSchema.virtual("records", {
  ref: "PatientProfileRecord",
  localField: "_id",
  foreignField: "profile",
});

const PatientProfile = mongoose.model("PatientProfile", PatientProfileSchema);

export default PatientProfile;
