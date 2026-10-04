import Reservation, {
  IReservation,
  ReservationParty,
} from "../Models/Reservation";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";
import DoctorProfile from "../Models/DoctorProfile";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { getAppConfig } from "../Lib/appConfig";
import {
  notifyWithSms,
  reservationSmsContext,
  smsAmount,
} from "./notificationSmsService";

// A patient can cancel online (full refund to the wallet) up to this many
// hours before the start - the same window the booking page tells them.
// The super admin sets it (AppConfig.patientFreeCancelHours, booking
// settings, 2026-10 - Doctolib / Zocdoc let the practice set it too); this
// constant is only the default and the fallback. The doctor can cancel any
// time before the start, and the patient is always refunded in full then.
export const PATIENT_FREE_CANCEL_HOURS = 24;

export const getPatientFreeCancelHours = async (): Promise<number> => {
  try {
    const hours = Number((await getAppConfig()).patientFreeCancelHours);
    return Number.isFinite(hours) && hours >= 0 && hours <= 168
      ? hours
      : PATIENT_FREE_CANCEL_HOURS;
  } catch {
    return PATIENT_FREE_CANCEL_HOURS;
  }
};

// reservation.date is local midnight of the day; start is minutes from it
export const reservationStartsAt = (reservation: IReservation): Date =>
  new Date(new Date(reservation.date).getTime() + reservation.start * 60000);

export const patientCanCancel = (
  reservation: IReservation,
  now = new Date(),
  freeCancelHours = PATIENT_FREE_CANCEL_HOURS,
) =>
  reservation.status === "pending" &&
  reservationStartsAt(reservation).getTime() - now.getTime() >=
    freeCancelHours * 3600 * 1000;

export const doctorCanCancel = (reservation: IReservation, now = new Date()) =>
  reservation.status === "pending" &&
  reservationStartsAt(reservation).getTime() > now.getTime();

const numberToTime = (m: number) =>
  `${`${Math.floor(m / 60)}`.padStart(2, "0")}:${`${m % 60}`.padStart(2, "0")}`;

/**
 * Cancels a still-pending reservation and refunds what the patient paid to
 * the booker's wallet. Returns the updated reservation, or null when it was
 * no longer pending (already cancelled / activated by the sweep meanwhile) -
 * the status flip is the guard, so a double click can't refund twice.
 */
export const cancelReservation = async (
  reservationId: string,
  by: ReservationParty,
  reason?: string,
): Promise<IReservation | null> => {
  const now = new Date();
  const reservation = await Reservation.findOneAndUpdate(
    { _id: reservationId, status: "pending" },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: by,
        ...(reason ? { cancelReason: reason } : {}),
      },
    },
    { new: true },
  );
  if (!reservation) return null;

  // refund exactly what was debited (total incl. tax; older bookings fall
  // back to their payment transaction)
  const paid = reservation.transaction
    ? await Transaction.findById(reservation.transaction)
    : null;
  const amount = reservation.total ?? (paid ? Math.abs(paid.amount) : 0);
  if (amount > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { user: reservation.user },
      { user: reservation.user },
      { upsert: true, new: true },
    );
    await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: amount } });
    await Transaction.create({
      user: reservation.user,
      amount,
      reservation: reservation._id,
    });
  }

  // the slot is bookable again
  const doctor = await DoctorProfile.findById(reservation.doctor);
  if (doctor)
    updateDoctorAvailability({
      doctor,
      startDate: reservation.date,
      endDate: reservation.date,
    }).catch(() => {});

  // in-app notice to the other side (same "System" notifications as the
  // lifecycle sweeps)
  const when = `${numberToTime(reservation.start)}`;
  const docs = [];
  if (by === "patient" && doctor?.user)
    docs.push({
      user: doctor.user,
      source: "System",
      title: "یک نوبت لغو شد",
      message: `بیمار نوبت ساعت ${when} را لغو کرد و زمان آن دوباره قابل رزرو است.`,
      link: `/doctorpanel/booking/${reservation._id}`,
    });
  if (by === "doctor")
    docs.push({
      user: reservation.user,
      source: "System",
      title: "نوبت شما توسط پزشک لغو شد",
      message: `نوبت ساعت ${when} لغو شد و مبلغ آن به کیف پول شما برگشت.`,
      link: `/dashboard/booking/${reservation._id}`,
    });
  if (docs.length) await Notification.insertMany(docs).catch(() => {});

  // the same notice by SMS (Models/NotificationSms.ts)
  if (by === "patient" || by === "doctor") {
    const ctx = await reservationSmsContext(reservation._id).catch(() => null);
    if (ctx && by === "patient")
      notifyWithSms("reservationCancelledDoctor", ctx.doctorUser, {
        reservationId: ctx.reservationId,
        patientName: ctx.patientName,
        date: ctx.date,
        time: ctx.time,
      });
    if (ctx && by === "doctor")
      notifyWithSms(
        "reservationCancelledPatient",
        ctx.patientUser,
        {
          reservationId: ctx.reservationId,
          doctorName: ctx.doctorName,
          date: ctx.date,
          time: ctx.time,
          amount: smsAmount(amount),
        },
        { phone: ctx.patientPhone },
      );
  }

  return reservation;
};
