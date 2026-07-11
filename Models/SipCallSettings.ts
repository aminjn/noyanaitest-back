import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface ISipCallSettings extends MongoDoc {
  doctor: IDoctorProfile;
  receiver?: string;
  price?: number;
  active: boolean;
}

const SipCallSettingsSchema = new mongoose.Schema<
  ISipCallSettings,
  Model<ISipCallSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  receiver: { type: String },
  price: { type: Number },
  active: { type: Boolean, default: false },
});

const SipCallSettings = mongoose.model(
  "SipCallSettings",
  SipCallSettingsSchema,
);

export default SipCallSettings;
