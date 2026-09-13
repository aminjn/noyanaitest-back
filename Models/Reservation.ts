import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";
import { IDoctorProfile } from "./DoctorProfile";
import { IOffice } from "./Office";
import { DoctorSessionType, doctorSessionTypes } from "./DoctorSession";
import { ITransaction } from "./Transaction";
import { IChat } from "./Chat";
import { ICallRoom } from "./CallRoom";

// Every entry here is one SMS a reservation's own doctor/patient (not staff
// - see Models/UserAlert.ts for the staff-alert event list) can receive
// about that specific reservation, sent via Services/reservationSmsService.ts.
// Each gets its own dedicated SmsPatterns field (Models/SmsPatterns.ts
// derives one per entry via Lib/smsPatternName.ts's smsPatternNameForEvent,
// same convention as userAlertEvents) - these are unconditional
// transactional sends, not gated by a staff opt-in toggle like UserAlert,
// so there's no push/SMS toggle pair here.
export const reservationSmsEvents = [
  // Sent once, right after a reservation is successfully booked -
  // Controllers/bookingController.ts's submitBookingNew.
  "newReservationDoctor",
  "newReservationPatient",
  // "Starts in N minutes" reminder - Services/reservationActivationService.ts's
  // runReservationReminderSweep, alongside the existing in-app/push
  // notification (notifyBoth) it already sends.
  "upcomingReservationDoctor",
  "upcomingReservationPatient",
  // Mid-session nudge: the reservation is active (in progress) and enough
  // time has passed since its start with one party never marked present -
  // nudges *that* absent party to join, before the finalization sweep ever
  // gets a chance to decide a no-show outcome. See
  // Services/reservationActivationService.ts's runReservationNoShowNudgeSweep
  // and doctorNoShowNudgeSentAt/patientNoShowNudgeSentAt below (2026-09 user
  // decision, via AskUserQuestion: nudge the absent party mid-session, not a
  // post-finalization self-notice and not a notice to the other party).
  "reservationInProgressDoctorNoShow",
  "reservationInProgressPatientNoShow",
] as const;

export type ReservationSmsEvent = (typeof reservationSmsEvents)[number];

// Per-event SMS variable shapes - see Models/UserAlert.ts's
// UserAlertSmsVariables comment for why this is a specific shape per event
// rather than a generic {title,message} pair (2026-09 correction). `date`/
// `time` are formatted (jalali date, HH:mm) by
// Services/reservationSmsService.ts before being sent - the pattern text
// itself just places them.
export type ReservationSmsVariables = {
  newReservationDoctor: {
    reservationId: string;
    patientName: string;
    date: string;
    time: string;
  };
  newReservationPatient: {
    reservationId: string;
    doctorName: string;
    date: string;
    time: string;
  };
  upcomingReservationDoctor: {
    reservationId: string;
    minutesBefore: string;
    date: string;
    time: string;
  };
  upcomingReservationPatient: {
    reservationId: string;
    minutesBefore: string;
    date: string;
    time: string;
  };
  // Just the id - this is a short mid-session nudge, its pattern text is
  // fixed ("please join now") and only needs a link back to the session.
  reservationInProgressDoctorNoShow: { reservationId: string };
  reservationInProgressPatientNoShow: { reservationId: string };
};

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
  // set by the reminder sweep if sending the reminder failed, so a
  // silently-failing reminder is inspectable instead of only visible in logs
  reminderError?: string;
  // set the first time each party is seen for this session - a chat message,
  // a joined call participant, an answered sip leg, or (for inPerson) the
  // doctor's manual check-in action. Presence means "was here at some point
  // during the session", not "is here right now".
  patientPresentAt?: Date;
  doctorPresentAt?: Date;
  // which party never showed, when status === "noShow"
  noShowParty?: ReservationParty;
  // set the first time the mid-session "please join" nudge SMS has been
  // sent to that party, so runReservationNoShowNudgeSweep doesn't re-send it
  // on every tick while the party is still absent. Independent of
  // patientPresentAt/doctorPresentAt (a party can show up after being
  // nudged, or the session can end without them ever showing).
  doctorNoShowNudgeSentAt?: Date;
  patientNoShowNudgeSentAt?: Date;
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
  reminderError: { type: String },
  patientPresentAt: { type: Date },
  doctorPresentAt: { type: Date },
  noShowParty: { type: String, enum: reservationParties },
  doctorNoShowNudgeSentAt: { type: Date },
  patientNoShowNudgeSentAt: { type: Date },
  finalizedAt: { type: Date },
  sipBridgeId: { type: String },
  sipDoctorChannelId: { type: String },
  sipPatientChannelId: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

// Serves the lifecycle sweeps (reservationActivationService.ts), which
// filter/sort by status+date+start.
ReservationSchema.index({ status: 1, date: 1, start: 1 });
// Serves the conflict-check on every booking attempt
// (bookingController.submitBookingNew: `Reservation.exists({ doctor, start,
// end, date })`) and updateDoctorAvailablity.ts's per-doctor date-range read,
// neither of which the status-led index above covers (AUDIT F-20 /
// 06_DATABASE_DRIFT.md Finding 6.3).
ReservationSchema.index({ doctor: 1, date: 1, start: 1 });

const Reservation = mongoose.model("Reservation", ReservationSchema);

export default Reservation;
