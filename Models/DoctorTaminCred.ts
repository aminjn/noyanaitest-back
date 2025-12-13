import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IDoctorTaminCred extends MongoDoc {
  doctor: IDoctorProfile;
  verifier?: string;
  challenge?: string;
  token?: string;
  tokenRefreshedAt?: Date;
}

const DoctorTaminCredSchema = new mongoose.Schema<
  IDoctorTaminCred,
  Model<IDoctorTaminCred>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  verifier: { type: String },
  challenge: { type: String },
  token: { type: String },
  tokenRefreshedAt: { type: Date },
});

const DoctorTaminCred = mongoose.model(
  "DoctorTaminCred",
  DoctorTaminCredSchema
);

export default DoctorTaminCred;
