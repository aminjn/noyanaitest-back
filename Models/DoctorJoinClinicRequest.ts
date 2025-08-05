import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDoctorJoinClinicRequest extends MongoDoc {}

const DoctorJoinClinicRequestSchema = new mongoose.Schema<
  IDoctorJoinClinicRequest,
  Model<IDoctorJoinClinicRequest>
>({});

const DoctorJoinClinicRequest = mongoose.model(
  "DoctorJoinClinicRequest",
  DoctorJoinClinicRequestSchema
);

export default DoctorJoinClinicRequest;
