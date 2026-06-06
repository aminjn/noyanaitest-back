import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IOffice } from "./Office";
import {
  DoctorSessionType,
  doctorSessionTypes,
  PatientStatus,
  patientStatuses,
} from "./DoctorSession";
import { IDoctorProfile } from "./DoctorProfile";

export const doctorShiftDays = [0, 1, 2, 3, 4, 5, 6] as const;
export type DoctorShiftDay = (typeof doctorShiftDays)[number];

export interface IDoctorShift extends MongoDoc {
  day: DoctorShiftDay;
  start: number;
  end: number;
  office: IOffice;
  duration: number;
  gap: number;
  sessionTypes: DoctorSessionType[];
  patientTypes: PatientStatus[];
  name: string;
  doctor: IDoctorProfile;
}

const DoctorShiftSchema = new mongoose.Schema<
  IDoctorShift,
  Model<IDoctorShift>
>({
  day: { type: Number, enum: doctorShiftDays, required: true },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  office: { type: mongoose.Schema.ObjectId, ref: "Office", required: true },
  duration: { type: Number, required: true },
  gap: { type: Number, default: 0 },
  sessionTypes: {
    type: [{ type: String, _id: false, enum: doctorSessionTypes }],
    default: [],
  },
  patientTypes: {
    type: [{ type: String, _id: false, enum: patientStatuses }],
    default: [],
  },
  name: { type: String, default: "شیفت جدید" },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
});

const DoctorShift = mongoose.model("DoctorShift", DoctorShiftSchema);

export default DoctorShift;
