import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDoctorSecretaryAccessLevel extends MongoDoc {}

const DoctorSecretaryAccessLevelSchema = new mongoose.Schema<
  IDoctorSecretaryAccessLevel,
  Model<IDoctorSecretaryAccessLevel>
>({});

const DoctorSecretaryAccessLevel = mongoose.model(
  "DoctorSecretaryAccessLevel",
  DoctorSecretaryAccessLevelSchema
);

export default DoctorSecretaryAccessLevel;
