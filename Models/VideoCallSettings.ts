import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IVideoCallSettings extends MongoDoc {
  doctor: IDoctorProfile;
  price?: number;
  active: boolean;
}

const VideoCallSettingsSchema = new mongoose.Schema<
  IVideoCallSettings,
  Model<IVideoCallSettings>
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

const VideoCallSettings = mongoose.model(
  "VideoCallSettings",
  VideoCallSettingsSchema,
);

export default VideoCallSettings;
