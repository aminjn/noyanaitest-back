import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IUserVital extends MongoDoc {
  user: IUser;
  author: IDoctorProfile;
  createdAt: Date;
  heartRate: number;
  bloodOxygen: number;
  bodyTemp: number;
  bloodPressure: number;
}

const UserVitalSchema = new mongoose.Schema<IUserVital, Model<IUserVital>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  author: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  createdAt: { type: Date, default: new Date() },
  heartRate: { type: Number },
  bloodOxygen: { type: Number },
  bodyTemp: { type: Number },
  bloodPressure: { type: Number },
});

const UserVital = mongoose.model("UserVital", UserVitalSchema);

export default UserVital;
