import mongoose, { Model } from "mongoose";
import { IUser } from "./User";

export interface IPatientProfile {
  user: IUser;
  //   doctor: IDoctor;
}

const PatientProfileSchema = new mongoose.Schema<
  IPatientProfile,
  Model<IPatientProfile>
>({});

const PatientProfile = mongoose.model("PatientProfile", PatientProfileSchema);

export default PatientProfile;
