import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IInPersonSettings extends MongoDoc {
  doctor: IDoctorProfile;
  price?: number;
  active: boolean;
  hidePrice: boolean;
}

const InPersonSettingsSchema = new mongoose.Schema<
  IInPersonSettings,
  Model<IInPersonSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  price: { type: Number },
  active: { type: Boolean, default: false },
  hidePrice: { type: Boolean, default: false },
});

const InPersonSettings = mongoose.model(
  "InPersonSettings",
  InPersonSettingsSchema,
);

export default InPersonSettings;
