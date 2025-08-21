import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IBooking } from "./Booking";

export const doctorSessionTypes = [
  "textChat",
  "sipCall",
  "voiceCall",
  "videoCall",
  "inPerson",
] as const;

export type DoctorSessionType = (typeof doctorSessionTypes)[number];

export type IDoctorSession = MongoDoc & {
  doctor: IDoctorProfile;
  date: string;
  start: number;
  end: number;
  booking?: IBooking;
  note?: string;
  createdAt: Date;
} & Partial<Record<DoctorSessionType, boolean>>;

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
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

DoctorSessionSchema.virtual("booking", {
  ref: "Booking",
  localField: "_id",
  foreignField: "session",
  justOne: true,
});

const DoctorSession = mongoose.model("DoctorSession", DoctorSessionSchema);

export default DoctorSession;
