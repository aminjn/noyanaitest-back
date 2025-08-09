import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDoctorSecretary extends MongoDoc {}

const DoctorSecretarySchema = new mongoose.Schema<
  IDoctorSecretary,
  Model<IDoctorSecretary>
>({});

const DoctorSecretary = mongoose.model(
  "DoctorSecretary",
  DoctorSecretarySchema
);

export default DoctorSecretary;
