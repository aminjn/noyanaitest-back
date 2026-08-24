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
// active     -> the session channel has been opened/dispatched by the cron -
//               NOT the same as "in progress": see patientPresentAt/
//               doctorPresentAt below for whether both parties actually
//               showed up
// completed  -> the session ran and both parties were present at some point
// cancelled  -> reservation was cancelled before it started
// noShow     -> the session's end time passed with only one party present;
//               see noShowParty for which one
// error      -> activation never managed to open a channel, or finalization
//               couldn't pin the outcome on either party (e.g. neither
//               showed up) - needs the error-scenario trigger/manual look
export const reservationStatuses = [
  "pending",
  "active",
  "completed",
  "cancelled",
  "noShow",
  "error",
] as const;

export type ReservationStatus = (typeof reservationStatuses)[number];

export const reservationParties = ["patient", "doctor"] as const;

export type ReservationParty = (typeof reservationParties)[number];

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
  // set once the "upcoming in N minutes" reminder has gone out, so the
  // reminder sweep doesn't send it twice
  reminderSentAt?: Date;
  // set the first time each party is seen for this session - a chat message,
  // a joined call participant, an answered sip leg, or (for inPerson) the
  // doctor's manual check-in action. Presence means "was here at some point
  // during the session", not "is here right now".
  patientPresentAt?: Date;
  doctorPresentAt?: Date;
  // which party never showed, when status === "noShow"
  noShowParty?: ReservationParty;
  // set by the finalization sweep once the outcome (completed/noShow/error)
  // has been decided and its trigger fired
  finalizedAt?: Date;
  // sipCall only: ARI bridge/channel ids for the two legs, persisted as soon
  // as they're known so the answered-leg callback (and any later action,
  // e.g. hanging up) can address the right channel
  sipBridgeId?: string;
  sipDoctorChannelId?: string;
  sipPatientChannelId?: string;
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
  reminderSentAt: { type: Date },
  patientPresentAt: { type: Date },
  doctorPresentAt: { type: Date },
  noShowParty: { type: String, enum: reservationParties },
  finalizedAt: { type: Date },
  sipBridgeId: { type: String },
  sipDoctorChannelId: { type: String },
  sipPatientChannelId: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

ReservationSchema.index({ status: 1, date: 1, start: 1 });

const Reservation = mongoose.model("Reservation", ReservationSchema);

export default Reservation;
