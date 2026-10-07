import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IInPersonSettings extends MongoDoc {
  doctor: IDoctorProfile;
  price?: number;
  active: boolean;
  hidePrice: boolean;
  // pay at the desk for an in-person visit (2026-10): on by default, as
  // before; payAtDeskOff lists the offices where it is off
  payAtDesk: boolean;
  payAtDeskOff: mongoose.Types.ObjectId[];
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
  payAtDesk: { type: Boolean, default: true },
  payAtDeskOff: { type: [{ type: mongoose.Schema.ObjectId, ref: "Office" }], default: [] },
});

const InPersonSettings = mongoose.model(
  "InPersonSettings",
  InPersonSettingsSchema,
);

export default InPersonSettings;
