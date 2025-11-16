import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export const bloodTypes = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
] as const;

export type BloodType = (typeof bloodTypes)[number];

export interface IMedicalDetail extends MongoDoc {
  user: IUser;
  height?: number;
  weight?: number;
  bloodType?: BloodType;
}

const MedicalDetailSchema = new mongoose.Schema<
  IMedicalDetail,
  Model<IMedicalDetail>
>({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  height: { type: Number },
  weight: { type: Number },
  bloodType: { type: String, enum: bloodTypes },
});

const MedicalDetail = mongoose.model("MedicalDetail", MedicalDetailSchema);

export default MedicalDetail;
