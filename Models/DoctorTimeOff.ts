import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

// Days a doctor doesn't work (2026-10): leave, holidays, a conference.
// `from` and `to` are whole days, both included. No slot is offered on
// them (Lib/updateDoctorAvailablity.ts) and no booking is taken. With
// startMin/endMin only those hours are blocked on each of the days (see
// Lib/timeOff.ts).
export interface IDoctorTimeOff extends MongoDoc {
  doctor: IDoctorProfile;
  from: Date;
  to: Date;
  note?: string;
  startMin?: number;
  endMin?: number;
  createdAt: Date;
}

const DoctorTimeOffSchema = new mongoose.Schema<IDoctorTimeOff, Model<IDoctorTimeOff>>({
  doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile", required: true },
  from: { type: Date, required: true },
  to: { type: Date, required: true },
  note: { type: String, maxlength: 200 },
  startMin: { type: Number, min: 0, max: 24 * 60 },
  endMin: { type: Number, min: 0, max: 24 * 60 },
  createdAt: { type: Date, default: () => new Date() },
});

DoctorTimeOffSchema.index({ doctor: 1, to: 1 });

const DoctorTimeOff = mongoose.model("DoctorTimeOff", DoctorTimeOffSchema);

export default DoctorTimeOff;
