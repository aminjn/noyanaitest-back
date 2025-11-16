import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IOffice extends MongoDoc {
  doctor: IDoctorProfile;
  name?: string;
  address?: string;
  tel?: string;
  order: number;
  active: boolean;
  location: { type: "Point"; coordinates: [number, number] };
}

const OfficeSchema = new mongoose.Schema<IOffice, Model<IOffice>>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  name: { type: String },
  address: { type: String },
  tel: { type: String },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
});

OfficeSchema.index({ location: "2dsphere" });

const Office = mongoose.model("Office", OfficeSchema);

export default Office;
