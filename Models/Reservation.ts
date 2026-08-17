import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";
import { IDoctorProfile } from "./DoctorProfile";
import { IOffice } from "./Office";
import { DoctorSessionType, doctorSessionTypes } from "./DoctorSession";
import { ITransaction } from "./Transaction";
import { IChat } from "./Chat";
import { ICallRoom } from "./CallRoom";

// pending    -> reservation is paid/confirmed, waiting for its scheduled time
//               so the cron sweep can open the right channel (chat/call/etc)
// active     -> the session channel has been opened/dispatched by the cron
// completed  -> the session has finished
// cancelled  -> reservation was cancelled before it started
// noShow     -> the session's time passed without either party joining
export const reservationStatuses = [
  "pending",
  "active",
  "completed",
  "cancelled",
  "noShow",
] as const;

export type ReservationStatus = (typeof reservationStatuses)[number];

export interface IReservation extends MongoDoc {
  user: IUser;
  patient: IUserIdentity;
  doctor: IDoctorProfile;
  date: Date;
  start: number;
  end: number;
  office: IOffice;
  sessionType: DoctorSessionType;
  transaction?: ITransaction;
  status: ReservationStatus;
  activatedAt?: Date;
  // set by the cron sweep when it dispatches a textChat / voiceCall / videoCall
  // session, so the frontend knows what to open and re-runs don't re-create one
  chat?: IChat;
  callRoom?: ICallRoom;
  // set by the cron sweep if dispatch failed, so it can be retried/inspected
  // instead of silently retrying forever
  dispatchError?: string;
  createdAt: Date;
}

const ReservationSchema = new mongoose.Schema<
  IReservation,
  Model<IReservation>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  patient: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  date: { type: Date, required: true },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  office: { type: mongoose.Schema.ObjectId, required: true, ref: "Office" },
  sessionType: { type: String, enum: doctorSessionTypes, required: true },
  transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  status: {
    type: String,
    enum: reservationStatuses,
    default: "pending",
    required: true,
  },
  activatedAt: { type: Date },
  chat: { type: mongoose.Schema.ObjectId, ref: "Chat" },
  callRoom: { type: mongoose.Schema.ObjectId, ref: "VoiceRoom" },
  dispatchError: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

ReservationSchema.index({ status: 1, date: 1, start: 1 });

const Reservation = mongoose.model("Reservation", ReservationSchema);

export default Reservation;
