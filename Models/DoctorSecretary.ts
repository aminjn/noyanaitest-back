import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IDoctorSecretaryAccessLevel } from "./DoctorSecretaryAccessLevel";

export interface IDoctorSecretary extends MongoDoc {
  doctor: IDoctorProfile;
  secretary: IUser;
  accessLevel?: IDoctorSecretaryAccessLevel;
  displayName?: string;
}

const DoctorSecretarySchema = new mongoose.Schema<
  IDoctorSecretary,
  Model<IDoctorSecretary>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  secretary: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  accessLevel: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorSecretaryAccessLevel",
  },
  displayName: { type: String },
});

DoctorSecretarySchema.index({ doctor: 1, secretary: 1 }, { unique: true });

const DoctorSecretary = mongoose.model(
  "DoctorSecretary",
  DoctorSecretarySchema
);

export default DoctorSecretary;
