import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDoctorSecretaryRequest extends MongoDoc {}

const DoctorSecretaryRequestSchema = new mongoose.Schema<
  IDoctorSecretaryRequest,
  Model<IDoctorSecretaryRequest>
>({});

const DoctorSecretaryRequest = mongoose.model(
  "DoctorSecretaryRequest",
  DoctorSecretaryRequestSchema
);

export default DoctorSecretaryRequest;
