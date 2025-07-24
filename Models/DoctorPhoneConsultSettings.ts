import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IPhoneConsultSettings extends MongoDoc {
  doctor: IDoctorProfile;
  duration: number;
  price: number;
  active: boolean;
  callDestination?: string;
}

const PhoneConsultSettingsSchema = new mongoose.Schema<
  IPhoneConsultSettings,
  Model<IPhoneConsultSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  duration: { type: Number, required: true },
  price: { type: Number, required: true },
  active: { type: Boolean, default: false },
  callDestination: { type: String, required: true },
});

const PhoneConsultSettings = mongoose.model(
  "PhoneConsultSettings",
  PhoneConsultSettingsSchema
);

export default PhoneConsultSettings;
