import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IDoctorPatient extends MongoDoc {
  createdAt: Date;
  user: IUser;
  doctor: IDoctorProfile;
}

const DoctorPatientSchema = new mongoose.Schema<
  IDoctorPatient,
  Model<IDoctorPatient>
>({
  createdAt: { type: Date, default: () => new Date() },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
});

DoctorPatientSchema.index({ user: 1, doctor: 1 }, { unique: true });

const DoctorPatient = mongoose.model("DoctorPatient", DoctorPatientSchema);

export default DoctorPatient;
