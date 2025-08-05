import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IClinicAdditionRequest extends MongoDoc {}

const ClinicAdditionRequestSchema = new mongoose.Schema<
  IClinicAdditionRequest,
  Model<IClinicAdditionRequest>
>({});

const ClinicAdditionRequest = mongoose.model(
  "ClinicAdditionRequest",
  ClinicAdditionRequestSchema
);

export default ClinicAdditionRequest;
