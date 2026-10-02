import moment from "moment-jalaali";
import {
  IReservation,
  ReservationParty,
  ReservationSmsEvent,
  ReservationSmsVariables,
} from "../Models/Reservation";
import { smsPatternNameForEvent } from "../Lib/smsPatternName";
import { sendSMS } from "../Lib/sendSms";
import UserIdentity from "../Models/UserIdentity";

// Direct-to-recipient SMS for a specific reservation's own doctor/patient -
// distinct from Services/userAlertService.ts (staff opt-in alerts) and from
// Services/reservationActivationService.ts's `notifyBoth` (in-app/push
// Notification docs, always sent regardless of SMS). These are
// unconditional transactional sends: every ReservationSmsEvent
// (Models/Reservation.ts) has its own dedicated SmsPatterns field, so a
// typo'd/renamed event is a compile error rather than a silently-wrong
// pattern - see reservationPattern below.
const reservationPattern = (event: ReservationSmsEvent) =>
  smsPatternNameForEvent(event);

// Mirrors Services/reservationActivationService.ts's private
// doctorUserId/patientPhone helpers (not exported from there, and this is a
// different concern - phone numbers for direct SMS, not the linked User._id
// that in-app Notification docs need).
const doctorPhone = (reservation: IReservation): string | undefined =>
  reservation.doctor.user?.phone;

// Prefers the patient's own account phone (when their UserIdentity is
// linked to a User - reservation.patient.user, populated by
// bookingController.submitBookingNew) over UserIdentity.phones, since an
// identity linked via addRelative's "already exists" branch (matched by
// national code) never gets `phones` written to it - only the "create a
// new UserIdentity" branch does. Falls back to the booker's own phone only
// for a relative with no account of their own at all.
const patientPhone = (reservation: IReservation): string | undefined =>
  reservation.patient.user?.phone ||
  reservation.patient.phones?.[0] ||
  reservation.user.phone;

const doctorFullName = (reservation: IReservation): string =>
  `${reservation.doctor.firstName || ""} ${reservation.doctor.lastName || ""}`.trim();

const patientFullName = (reservation: IReservation): string =>
  `${reservation.patient.givenName} ${reservation.patient.lastName}`.trim();

// True when whoever booked this reservation (reservation.user) isn't the
// patient themselves - i.e. it was booked for a relative
// (Models/UserRelative.ts), same test as
// Controllers/bookingController.ts's submitBookingNew ownership check.
// A patient identity with no linked account at all (relative with no login
// of their own) also counts as "booked for someone else".
const isBookedForRelative = (reservation: IReservation): boolean =>
  reservation.user._id.toString() !==
  (reservation.patient.user?._id?.toString() ?? "");

// The booker's own display name, for the "X booked you an appointment"
// copy - User itself has no name field, only the UserIdentity linked to
// it does (same lookup Controllers/userController.ts's addRelative does
// via `UserIdentity.findOne({ user: req.user._id })`). Falls back to a
// phone number if the booker somehow has no identity on file.
const bookerFullName = async (reservation: IReservation): Promise<string> => {
  const bookerIdentity = await UserIdentity.findOne({
    user: reservation.user._id,
  });
  if (bookerIdentity)
    return `${bookerIdentity.givenName} ${bookerIdentity.lastName}`.trim();
  return reservation.user.phone;
};

// reservation.date is midnight of the reservation's day; `start` is
// minutes-from-midnight (see Models/Reservation.ts) - these turn that into
// the two plain strings a pattern's {date}/{time} placeholders need. Jalali
// formatting mirrors the existing "jYYYYjMMjDD" convention used elsewhere
// in this codebase (e.g. Controllers/prescriptionController.ts), with
// separators here since this is read by a person, not an external API.
const reservationDateString = (reservation: IReservation): string =>
  moment(reservation.date).format("jYYYY/jMM/jDD");

const reservationTimeString = (minutesFromMidnight: number): string => {
  const hours = Math.floor(minutesFromMidnight / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (minutesFromMidnight % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
};

const sendReservationSms = async <E extends ReservationSmsEvent>(
  to: string | undefined,
  event: E,
  variables: ReservationSmsVariables[E],
  logContext: string,
): Promise<void> => {
  if (!to) {
    console.log(
      `[reservationSms] no phone number available for ${logContext} - skipping`,
    );
    return;
  }
  await sendSMS(to, variables, reservationPattern(event)).catch((err) =>
    console.log(`[reservationSms] failed to send ${logContext}:`, err),
  );
};

// --- New reservation --------------------------------------------------
// Fired once, right after a reservation is successfully booked -
// Controllers/bookingController.ts's submitBookingNew. Confirms the
// booking to the patient and alerts the doctor of a new appointment.
// Fire-and-forget from the caller's point of view: a delivery failure here
// must never fail or slow down the booking request that triggered it.
export const notifyNewReservation = async (
  reservation: IReservation,
): Promise<void> => {
  const date = reservationDateString(reservation);
  const time = reservationTimeString(reservation.start);
  const reservationId = reservation._id.toString();

  // Booking-for-a-relative (2026-09): the patient still gets an SMS either
  // way, but which event/pattern depends on who actually booked it, so the
  // relative gets "X booked you an appointment" instead of being told
  // "you" booked something they never touched.
  const patientNotification = isBookedForRelative(reservation)
    ? sendReservationSms(
        patientPhone(reservation),
        "newReservationRelativePatient",
        {
          reservationId,
          doctorName: doctorFullName(reservation),
          date,
          time,
          bookerName: await bookerFullName(reservation),
        },
        `newReservationRelativePatient (reservation ${reservation._id})`,
      )
    : sendReservationSms(
        patientPhone(reservation),
        "newReservationPatient",
        { reservationId, doctorName: doctorFullName(reservation), date, time },
        `newReservationPatient (reservation ${reservation._id})`,
      );

  await Promise.all([
    sendReservationSms(
      doctorPhone(reservation),
      "newReservationDoctor",
      { reservationId, patientName: patientFullName(reservation), date, time },
      `newReservationDoctor (reservation ${reservation._id})`,
    ),
    patientNotification,
  ]);
};

// --- Upcoming reservation reminder -------------------------------------
// Called from Services/reservationActivationService.ts's
// runReservationReminderSweep, alongside the in-app/push reminder it
// already sends via notifyBoth - this is the SMS channel for the same
// event.
export const notifyUpcomingReservationSms = async (
  reservation: IReservation,
  minutesBefore: number,
): Promise<void> => {
  const date = reservationDateString(reservation);
  const time = reservationTimeString(reservation.start);
  const reservationId = reservation._id.toString();
  const minutesBeforeString = minutesBefore.toString();

  await Promise.all([
    sendReservationSms(
      doctorPhone(reservation),
      "upcomingReservationDoctor",
      { reservationId, minutesBefore: minutesBeforeString, date, time },
      `upcomingReservationDoctor (reservation ${reservation._id})`,
    ),
    sendReservationSms(
      patientPhone(reservation),
      "upcomingReservationPatient",
      { reservationId, minutesBefore: minutesBeforeString, date, time },
      `upcomingReservationPatient (reservation ${reservation._id})`,
    ),
  ]);
};

// --- Mid-session no-show nudge -----------------------------------------
// Called from Services/reservationActivationService.ts's new
// runReservationNoShowNudgeSweep: the reservation is active (in progress)
// and enough time has passed since its start with `party` never marked
// present. Nudges *that* absent party only (not the other one, and not a
// post-finalization "you missed it" notice - 2026-09 user decision via
// AskUserQuestion).
export const notifyReservationNoShowNudge = async (
  reservation: IReservation,
  party: ReservationParty,
): Promise<void> => {
  const reservationId = reservation._id.toString();
  if (party === "doctor") {
    await sendReservationSms(
      doctorPhone(reservation),
      "reservationInProgressDoctorNoShow",
      { reservationId },
      `reservationInProgressDoctorNoShow (reservation ${reservation._id})`,
    );
  } else {
    await sendReservationSms(
      patientPhone(reservation),
      "reservationInProgressPatientNoShow",
      { reservationId },
      `reservationInProgressPatientNoShow (reservation ${reservation._id})`,
    );
  }
};

// An in-person visit ended with no check-in and was counted as done
// (2026-10): asks the patient whether they were visited, with the link to
// object within the dispute window.
export const notifyVisitConfirmSms = async (
  reservation: IReservation,
): Promise<void> => {
  await sendReservationSms(
    patientPhone(reservation),
    "visitConfirmPatient",
    {
      reservationId: reservation._id.toString(),
      doctorName: doctorFullName(reservation),
      date: reservationDateString(reservation),
    },
    `visitConfirmPatient (reservation ${reservation._id})`,
  );
};
