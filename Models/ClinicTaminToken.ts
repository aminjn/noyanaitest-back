import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";

export interface IClinicTaminToken extends MongoDoc {
  clinic: IClinic;
  verifier?: string;
  challenge?: string;
  token?: string;
  tokenRefreshedAt?: Date;
}

const ClinicTaminTokenSchema = new mongoose.Schema<
  IClinicTaminToken,
  Model<IClinicTaminToken>
>({
  clinic: {
    type: mongoose.Schema.ObjectId,
    ref: "Clinic",
    required: true,
    unique: true,
  },
  verifier: { type: String },
  challenge: { type: String },
  token: { type: String },
  tokenRefreshedAt: { type: Date },
});

const ClinicTaminToken = mongoose.model(
  "ClinicTaminToken",
  ClinicTaminTokenSchema,
);

export default ClinicTaminToken;
