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
  // Sent to the patient when they booked their own appointment.
  "newReservationPatient",
  // Sent INSTEAD of newReservationPatient when the booking was made for a
  // relative (Models/UserRelative.ts) rather than by the patient
  // themselves - i.e. `reservation.user` isn't the patient identity's
  // linked account. Its own pattern/text (bookerName variable) is what
  // lets this say "X booked you an appointment" rather than reusing
  // newReservationPatient's "you booked an appointment" copy for someone
  // who never touched the booking flow (2026-09).
  "newReservationRelativePatient",
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
  // An in-person visit ended with no check-in: it counts as done for the
  // doctor unless the patient objects within VISIT_DISPUTE_HOURS (2026-10).
  // Asks the patient "were you visited?" with a link to object.
  "visitConfirmPatient",
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
  newReservationRelativePatient: {
    reservationId: string;
    doctorName: string;
    date: string;
    time: string;
    bookerName: string;
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
  visitConfirmPatient: { reservationId: string; doctorName: string; date: string };
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
// how long a patient may object to an in-person visit that was counted as
// done without a check-in
export const VISIT_DISPUTE_HOURS = 48;

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

// What a back-office admin did to a reservation (2026-10,
// Controllers/adminReservationController.ts) - kept on the record itself so
// support sees the history next to the visit, besides the global audit log.
export const reservationAdminActions = [
  "cancel",
  "refund",
  "reschedule",
  "resolveRefund",
  "resolveComplete",
  "resolveAccept",
] as const;

export type ReservationAdminAction = (typeof reservationAdminActions)[number];

export interface IReservationAdminAction {
  action: ReservationAdminAction;
  by: IUser;
  at: Date;
  reason: string;
  // money moved to the patient (refund) / taken back from the doctor
  amount?: number;
  reversedPayout?: number;
  // reschedule: the slot before the move
  fromDate?: Date;
  fromStart?: number;
  fromEnd?: number;
}

export interface IReservation extends MongoDoc {
  user: IUser;
  patient: IUserIdentity;
  doctor: IDoctorProfile;
  date: Date;
  start: number;
  end: number;
  office: IOffice;
  sessionType: DoctorSessionType;
  // Price snapshot at booking time (2026-09) - `subtotal` is the session's
  // settings.price untouched (what's shown to the patient throughout), `tax`
  // is computed from the doctor's visit tax rate (Lib/taxSettings.ts's
  // getDoctorVisitTaxPercent), and `total` = subtotal + tax is what's
  // actually debited from the patient's wallet
  // (Controllers/bookingController.ts submitBookingNew). Optional because
  // reservations created before this field existed won't have it -
  // Services/reservationProgressService.ts's handleReservationSuccess falls
  // back to the linked Transaction's amount for those.
  subtotal?: number;
  tax?: number;
  total?: number;
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
  // the 24-hour and 2-hour reminders to the patient (in-app + SMS, 2026-10,
  // runReservationStageReminderSweep): claimed atomically when sent, so each
  // goes out once per reservation even across restarts. A reschedule clears
  // them (the new time gets its own reminders).
  reminder24hSentAt?: Date;
  reminder2hSentAt?: Date;
  // when the current date/start was set by a reschedule (createdAt for a
  // booking never moved): a stage whose window had already opened by then
  // is skipped - the booking / reschedule notice just told them the time
  slotSetAt?: Date;
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
  // in-person visit finalized with no check-in (2026-10): counted as done
  // for the doctor; the patient may object until disputeDeadline
  autoCompleted?: boolean;
  disputeDeadline?: Date;
  // the patient's objection; the reservation then waits for an admin
  // (needsAction queue, resolve refund/complete)
  dispute?: { at: Date; reason: string };
  // set when the reservation was cancelled (Services/reservationCancelService)
  cancelledAt?: Date;
  // "admin": cancelled from the super admin back office
  cancelledBy?: ReservationParty | "admin";
  adminActions?: IReservationAdminAction[];
  // short claim taken while an admin money action runs, so two admins can
  // never refund the same reservation at the same time
  adminLockAt?: Date;
  cancelReason?: string;
  source?: "online" | "desk";
  deskFee?: number;
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
  subtotal: { type: Number, min: 0 },
  tax: { type: Number, min: 0 },
  total: { type: Number, min: 0 },
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
  reminder24hSentAt: { type: Date },
  reminder2hSentAt: { type: Date },
  slotSetAt: { type: Date },
  patientPresentAt: { type: Date },
  doctorPresentAt: { type: Date },
  noShowParty: { type: String, enum: reservationParties },
  doctorNoShowNudgeSentAt: { type: Date },
  patientNoShowNudgeSentAt: { type: Date },
  finalizedAt: { type: Date },
  autoCompleted: { type: Boolean },
  disputeDeadline: { type: Date },
  dispute: {
    type: { _id: false, at: Date, reason: { type: String, maxlength: 1000 } },
    default: undefined,
  },
  cancelledAt: { type: Date },
  cancelledBy: { type: String, enum: [...reservationParties, "admin"] },
  adminActions: {
    type: [
      {
        _id: false,
        action: { type: String, enum: reservationAdminActions, required: true },
        by: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
        at: { type: Date, default: () => new Date() },
        reason: { type: String, maxlength: 1000, required: true },
        amount: { type: Number, min: 0 },
        reversedPayout: { type: Number, min: 0 },
        fromDate: { type: Date },
        fromStart: { type: Number },
        fromEnd: { type: Number },
      },
    ],
    default: undefined,
    // back-office only: never sent to the patient or the doctor
    select: false,
  },
  adminLockAt: { type: Date, select: false },
  cancelReason: { type: String, maxlength: 500 },
  // "desk": booked by the doctor's desk or on the phone (2026-10). Paid at
  // the visit, not online: total stays 0 and deskFee is the listed price.
  source: { type: String, enum: ["online", "desk"], default: "online" },
  deskFee: { type: Number, min: 0 },
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

// The doctor's patient list (DoctorPatient) fills itself from bookings
// (2026-10): every booked patient becomes the doctor's patient, whichever
// path created the reservation (online booking, desk booking, admin).
ReservationSchema.post("save", async function (doc) {
  try {
    const user = (doc.user as unknown as { _id?: unknown })?._id ?? doc.user;
    const doctor = (doc.doctor as unknown as { _id?: unknown })?._id ?? doc.doctor;
    if (!user || !doctor) return;
    await mongoose
      .model("DoctorPatient")
      .updateOne({ user, doctor }, { $setOnInsert: { user, doctor } }, { upsert: true });
  } catch {
    // a duplicate from a race is the same row; never fail the booking
  }
});

const Reservation = mongoose.model("Reservation", ReservationSchema);

export default Reservation;
