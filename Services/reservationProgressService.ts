import { creditEarning } from "../Lib/payoutHold";
import { getCommissionPercent, splitCommission } from "../Lib/commission";
import mongoose from "mongoose";
import Reservation, {
  IReservation,
  ReservationParty,
} from "../Models/Reservation";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";
import {
  notifyWithSms,
  reservationSmsContext,
  smsAmount,
  smsDate,
} from "./notificationSmsService";
import { getPatientFreeCancelHours } from "./reservationCancelService";

// Called from each channel's own "someone showed up" signal: a joined call
// participant (voiceCall/videoCall), a sent chat message (textChat), an
// answered sip leg (sipCall), or the doctor's manual check-in (inPerson).
// Idempotent and one-directional - only ever records the FIRST time a party
// is seen, mirroring how CallParticipant.joinedAt / a chat's first message
// already work elsewhere: "present" means "was here at some point during
// the session," not "is here right now." That's enough for the
// finalization sweep in reservationActivationService.ts to decide the
// reservation's outcome once it's over.
export const markReservationPresent = async (
  reservationId: string | mongoose.Types.ObjectId,
  party: ReservationParty,
): Promise<void> => {
  const field = party === "patient" ? "patientPresentAt" : "doctorPresentAt";
  await Reservation.updateOne(
    { _id: reservationId, [field]: { $exists: false } },
    { $set: { [field]: new Date() } },
  );
};

// --- Outcome triggers ---------------------------------------------------
// These are the four scenarios the reservation flow ends in. The actual
// business actions for each (extra notifications, payouts/refunds,
// follow-ups, flags, analytics, etc.) are NOT implemented yet - that's
// deliberately deferred. What's here is just the trigger point: the
// finalization sweep calls exactly one of these once a reservation's
// outcome is known, so the real logic can be filled in later without
// touching the sweep/detection code again.

// Both parties were present at some point during the session.
// Credits the doctor's wallet for the completed reservation, mirroring the
// debit the patient took when they booked it (Controllers/bookingController.ts
// submitBookingNew). The payout amount is the patient's pre-tax price
// (reservation.subtotal) minus the platform commission, plus the visit's VAT:
// the doctor is the seller of record and declares that VAT (2026-10).
export const handleReservationSuccess = async (
  reservation: IReservation,
): Promise<void> => {
  const doctorUserId = reservation.doctor.user?._id;
  if (!doctorUserId) {
    console.log(
      `[reservationProgress] cannot credit doctor for reservation ${reservation._id}: doctor has no linked user account`,
    );
    return;
  }
  // Idempotent - the finalization sweep only persists reservation.status
  // after this resolves, so a retry (e.g. after a transient error below)
  // must not double-credit the doctor.
  const alreadyCredited = await Transaction.exists({
    reservation: reservation._id,
    doctor: reservation.doctor._id,
  });
  if (alreadyCredited) return;
  const patientTransaction = reservation.transaction
    ? await Transaction.findById(reservation.transaction)
    : null;
  if (!patientTransaction) {
    console.log(
      `[reservationProgress] cannot credit doctor for reservation ${reservation._id}: no patient payment transaction found`,
    );
    return;
  }
  // payout = the visit's pre-tax price minus the platform commission (see
  // Lib/commission.ts: online consultations pay the doctor's rate, in-person
  // visits the in-person rate). Falls back to the full patientTransaction
  // amount for reservations booked before reservation.subtotal existed.
  // a code of the doctor's own club is the doctor's discount (2026-10)
  const gross = Math.max(
    0,
    (reservation.subtotal ?? Math.abs(patientTransaction.amount)) -
      Math.max(0, reservation.clubDiscount || 0),
  );
  const percent = await getCommissionPercent(
    reservation.sessionType === "inPerson" ? "doctorInPerson" : "doctorOnline",
    reservation.doctor._id,
  );
  const { commission, net } = splitCommission(gross, percent);
  // the doctor is the seller of record (2026-10): the VAT the patient paid
  // is theirs to declare on their own Moadian invoice, so it is paid out
  // with the earning (commission is on the pre-tax price only). Older
  // reservations without subtotal paid gross = total and carry no tax.
  const tax = reservation.subtotal != null ? Math.max(0, reservation.tax || 0) : 0;
  // into the settlement hold (Lib/payoutHold.ts), withdrawable after it
  await creditEarning(doctorUserId, net + tax, {
    reservation: reservation._id,
    doctor: reservation.doctor._id,
    grossAmount: gross,
    commission,
    commissionPercent: percent,
    tax,
    // the «پرو» discount the patient did not pay: the platform's share
    // (Lib/business/ledgerPoster.ts books it as its expense)
    ...(reservation.proDiscount && reservation.proDiscount > 0
      ? { platformSubsidy: reservation.proDiscount }
      : {}),
  } as any);
};

// Doctor was present, patient never showed: the doctor kept the time free,
// so they are paid as for a completed visit (same idempotent payout); the
// patient is told why there's no refund.
export const handlePatientNoShow = async (
  reservation: IReservation,
): Promise<void> => {
  await handleReservationSuccess(reservation);
  const bookerId = reservation.user?._id ?? reservation.user;
  await Notification.create({
    user: bookerId,
    source: "System",
    title: "شما در نوبت حاضر نشدید",
    // a desk booking was never paid online: nothing went to the doctor
    message:
      reservation.source === "desk"
        ? `پزشک در زمان نوبت آماده بود. اگر نمی‌توانید بیایید، تا ${(
            await getPatientFreeCancelHours()
          ).toLocaleString("fa-IR")} ساعت پیش از نوبت لغوش کنید تا وقت به بیمار دیگری برسد.`
        : `پزشک در زمان نوبت آماده بود و هزینه‌ی نوبت به او پرداخت شد. برای لغو رایگان، تا ${(
            await getPatientFreeCancelHours()
          ).toLocaleString("fa-IR")} ساعت پیش از نوبت اقدام کنید.`,
    link: `/dashboard/booking/${reservation._id}`,
  }).catch(() => {});
  const ctx = await reservationSmsContext(reservation._id).catch(() => null);
  if (ctx)
    notifyWithSms(
      "reservationNoShowPatient",
      bookerId,
      { reservationId: ctx.reservationId, doctorName: ctx.doctorName, date: ctx.date },
    );
};

// Gives the patient back everything they paid for a visit that didn't take
// place through no fault of theirs. Idempotent: a refund transaction for
// this reservation is written once (a retry of the sweep must not pay
// twice). The cancel flow (Services/reservationCancelService.ts) only ever
// refunds still-pending reservations, so the two can't overlap.
const refundPatient = async (
  reservation: IReservation,
  notice: { title: string; message: string },
): Promise<void> => {
  const bookerId = reservation.user?._id ?? reservation.user;
  const already = await Transaction.exists({
    reservation: reservation._id,
    user: bookerId,
    amount: { $gt: 0 },
  });
  if (already) return;
  const paid = reservation.transaction
    ? await Transaction.findById(reservation.transaction)
    : null;
  const amount = reservation.total ?? (paid ? Math.abs(paid.amount) : 0);
  if (amount <= 0) return;
  const wallet = await Wallet.findOneAndUpdate(
    { user: bookerId },
    { user: bookerId },
    { upsert: true, new: true },
  );
  await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: amount } });
  await Transaction.create({
    user: bookerId,
    amount,
    reservation: reservation._id,
  });
  await Notification.create({
    user: bookerId,
    source: "System",
    ...notice,
    link: `/dashboard/booking/${reservation._id}`,
  }).catch(() => {});
  notifyWithSms("reservationRefundedPatient", bookerId, {
    reservationId: String(reservation._id),
    amount: smsAmount(amount),
  });
};

// Patient was present, doctor never showed: full refund to the patient.
export const handleDoctorNoShow = async (
  reservation: IReservation,
): Promise<void> => {
  await refundPatient(reservation, {
    title: "پزشک در نوبت حاضر نشد",
    message: "مبلغ کامل نوبت به کیف پول شما برگشت. می‌توانید نوبت دیگری رزرو کنید.",
  });
  const doctorUserId = reservation.doctor?.user?._id;
  if (doctorUserId)
    await Notification.create({
      user: doctorUserId,
      source: "System",
      title: "غیبت در نوبت ثبت شد",
      message: "شما در زمان نوبت حاضر نشدید و مبلغ آن به بیمار برگشت داده شد.",
      link: `/doctorpanel/booking/${reservation._id}`,
    }).catch(() => {});
  if (doctorUserId)
    notifyWithSms("reservationNoShowDoctor", doctorUserId, {
      reservationId: String(reservation._id),
      date: smsDate(reservation.date),
    });
};

// Reservation could not be resolved cleanly: activation never managed to
// open a channel (dispatchError), or the session ended with neither party
// ever marked present. The visit didn't happen: refund the patient.
export const handleReservationError = async (
  reservation: IReservation,
): Promise<void> => {
  await refundPatient(reservation, {
    title: "نوبت شما برگزار نشد",
    message: "به دلیل مشکل در برگزاری، مبلغ کامل نوبت به کیف پول شما برگشت.",
  });
};
