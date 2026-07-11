import mongoose, { Model } from "mongoose";
import { IDoctorProfile } from "./DoctorProfile";
import { MongoDoc } from "./User";

export interface ITextChatSettings extends MongoDoc {
  doctor: IDoctorProfile;
  price?: number;
  active: boolean;
}

const TextChatSettingsSchema = new mongoose.Schema<
  ITextChatSettings,
  Model<ITextChatSettings>
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

const TextChatSettings = mongoose.model(
  "TextChatSettings",
  TextChatSettingsSchema,
);

export default TextChatSettings;
