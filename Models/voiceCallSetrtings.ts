import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IVoiceCallSettings extends MongoDoc {
  doctor: IDoctorProfile;
  price?: number;
  active: boolean;
}

const VoiceCallSettingsSchema = new mongoose.Schema<
  IVoiceCallSettings,
  Model<IVoiceCallSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  price: { type: Number },
  active: { type: Boolean, default: false },
});

const VoiceCallSettings = mongoose.model(
  "VoiceCallSettings",
  VoiceCallSettingsSchema
);

export default VoiceCallSettings;
