import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IBooking } from "./Booking";
import { IOffice } from "./Office";

export const doctorSessionTypes = [
  "inPerson",
  "textChat",
  "sipCall",
  "voiceCall",
  "videoCall",
  "phone",
] as const;

export type DoctorSessionType = (typeof doctorSessionTypes)[number];

export const patientStatuses = ["oldPatient", "newPatient"] as const;

export type PatientStatus = (typeof patientStatuses)[number];

export type IDoctorSession = MongoDoc & {
  doctor: IDoctorProfile;
  date: string;
  start: number;
  end: number;
  booking?: IBooking;
  note?: string;
  createdAt: Date;
  clinic: IOffice;
} & Partial<Record<DoctorSessionType, boolean>> &
  Partial<Record<PatientStatus, boolean>>;

const DoctorSessionSchema = new mongoose.Schema<
  IDoctorSession,
  Model<IDoctorSession>
>(
  {
    doctor: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    date: { type: String, required: true },
    start: { type: Number, required: true, min: 0, max: 1440 },
    end: { type: Number, required: true, min: 0, max: 1440 },
    note: { type: String, trim: true },
    createdAt: { type: Date, default: () => new Date() },
    ...patientStatuses.reduce(
      (acc, el) => ({ ...acc, [el]: { type: Boolean } }),
      {},
    ),
    ...doctorSessionTypes.reduce(
      (acc, el) => ({ ...acc, [el]: { type: Boolean } }),
      {},
    ),
    clinic: {
      type: mongoose.Schema.ObjectId,
      ref: "Office",
    },
    booking: { type: mongoose.Schema.ObjectId, ref: "Booking" },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// Matches the actual query shape used everywhere this model is read:
// createSession/addSessions/editSession's overlap checks filter by
// {doctor, date, start, end}, and getSessionsByDaySummary/getSessionsByDayFull
// filter by {date, doctor}. No index existed before this (AUDIT F-20 /
// 06_DATABASE_DRIFT.md Finding 6.3), so every one of these was a collection
// scan.
DoctorSessionSchema.index({ doctor: 1, date: 1, start: 1 });

const DoctorSession = mongoose.model("DoctorSession", DoctorSessionSchema);

export default DoctorSession;
