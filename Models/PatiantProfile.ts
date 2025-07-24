import mongoose, { Model } from "mongoose";
import { IUser } from "./User";
import { IPatientProfileDocument } from "./PatientProfileDocument";

export interface IPatientProfile {
  user: IUser;
  //   doctor: IDoctor;
  createdAt: Date;
  documents: IPatientProfileDocument[];
}

const PatientProfileSchema = new mongoose.Schema<
  IPatientProfile,
  Model<IPatientProfile>
>({});

const PatientProfile = mongoose.model("PatientProfile", PatientProfileSchema);

export default PatientProfile;
