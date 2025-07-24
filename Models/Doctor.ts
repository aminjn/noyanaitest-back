import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDoctor extends MongoDoc {}

const DoctorSchema = new mongoose.Schema<IDoctor, Model<IDoctor>>({});

const Doctor = mongoose.model("Doctor", DoctorSchema);

export default Doctor;
