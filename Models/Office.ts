import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IClinic } from "./Clinic";
import { IHospital } from "./Hospital";

export interface IOffice extends MongoDoc {
  doctor: IDoctorProfile;
  name?: string;
  address?: string;
  tel?: string;
  order: number;
  active: boolean;
  location: { type: "Point"; coordinates: [number, number] };
  // The centre this office is inside (2026-09), if any - only a clinic /
  // hospital the doctor is a member of. Reservations reach a centre through
  // their office, so this is what the centre's visit stats count. Cleared
  // when the doctor leaves or is removed from that centre.
  clinic?: IClinic;
  hospital?: IHospital;
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
  clinic: { type: mongoose.Schema.ObjectId, ref: "Clinic", index: true },
  hospital: { type: mongoose.Schema.ObjectId, ref: "Hospital", index: true },
});

OfficeSchema.index({ location: "2dsphere" });

const Office = mongoose.model("Office", OfficeSchema);

export default Office;
