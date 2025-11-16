import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IMedicalSystemInfo extends MongoDoc {
  user: IUser;
}

const MedicalSystemInfoSchema = new mongoose.Schema<
  IMedicalSystemInfo,
  Model<IMedicalSystemInfo>
>({});

const MedicalSystemInfo = mongoose.model(
  "MedicalSystemInfo",
  MedicalSystemInfoSchema
);

export default MedicalSystemInfo;
