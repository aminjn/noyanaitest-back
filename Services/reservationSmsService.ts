import {
  IReservation,
  ReservationParty,
  ReservationSmsEvent,
} from "../Models/Reservation";
import { smsPatternNameForEvent } from "../Lib/smsPatternName";
import { sendSMS } from "../Lib/sendSms";

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

type SmsContent = { title: string; message: string };

// Mirrors Services/reservationActivationService.ts's private
// doctorUserId/patientPhone helpers (not exported from there, and this is a
// different concern - phone numbers for direct SMS, not the linked User._id
// that in-app Notification docs need).
const doctorPhone = (reservation: IReservation): string | undefined =>
  reservation.doctor.user?.phone;

const patientPhone = (reservation: IReservation): string | undefined =>
  reservation.patient.phones?.[0] || reservation.user.phone;

const sendReservationSms = async (
  to: string | undefined,
  event: ReservationSmsEvent,
  content: SmsContent,
  logContext: string,
): Promise<void> => {
  if (!to) {
    console.log(
      `[reservationSms] no phone number available for ${logContext} - skipping`,
    );
    return;
  }
  await sendSMS(to, content, reservationPattern(event)).catch((err) =>
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
  await Promise.all([
    sendReservationSms(
      doctorPhone(reservation),
      "newReservationDoctor",
      {
        title: "نوبت جدید",
        message: "یک نوبت جدید برای شما رزرو شد.",
      },
      `newReservationDoctor (reservation ${reservation._id})`,
    ),
    sendReservationSms(
      patientPhone(reservation),
      "newReservationPatient",
      {
        title: "رزرو نوبت",
        message: "نوبت شما با موفقیت رزرو شد.",
      },
      `newReservationPatient (reservation ${reservation._id})`,
    ),
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
  await Promise.all([
    sendReservationSms(
      doctorPhone(reservation),
      "upcomingReservationDoctor",
      {
        title: "یادآوری نوبت",
        message: `نوبت شما تا ${minutesBefore} دقیقه دیگر آغاز می‌شود.`,
      },
      `upcomingReservationDoctor (reservation ${reservation._id})`,
    ),
    sendReservationSms(
      patientPhone(reservation),
      "upcomingReservationPatient",
      {
        title: "یادآوری نوبت",
        message: `نوبت شما تا ${minutesBefore} دقیقه دیگر آغاز می‌شود.`,
      },
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
  if (party === "doctor") {
    await sendReservationSms(
      doctorPhone(reservation),
      "reservationInProgressDoctorNoShow",
      {
        title: "نوبت در حال انجام است",
        message: "بیمار منتظر شماست، لطفا هرچه سریع‌تر به نوبت بپیوندید.",
      },
      `reservationInProgressDoctorNoShow (reservation ${reservation._id})`,
    );
  } else {
    await sendReservationSms(
      patientPhone(reservation),
      "reservationInProgressPatientNoShow",
      {
        title: "نوبت در حال انجام است",
        message: "پزشک منتظر شماست، لطفا هرچه سریع‌تر به نوبت بپیوندید.",
      },
      `reservationInProgressPatientNoShow (reservation ${reservation._id})`,
    );
  }
};
