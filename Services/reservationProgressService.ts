import mongoose from "mongoose";
import Reservation, {
  IReservation,
  ReservationParty,
} from "../Models/Reservation";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";

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
// (reservation.subtotal) - a real formula (fees, cuts, etc.) is a later
// task, but tax specifically must never reach the doctor's payout (2026-09):
// it's the buyer's added-on charge, not the doctor's revenue.
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
  // TODO: replace with the real payout formula - for now the doctor is
  // credited the patient's pre-tax price. Falls back to the full
  // patientTransaction amount for reservations booked before
  // reservation.subtotal existed (2026-09 tax rollout).
  const amount =
    reservation.subtotal ?? Math.abs(patientTransaction.amount);
  const wallet = await Wallet.findOneAndUpdate(
    { user: doctorUserId },
    { user: doctorUserId },
    { upsert: true, new: true },
  );
  await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: amount } });
  await Transaction.create({
    user: doctorUserId,
    amount,
    reservation: reservation._id,
    doctor: reservation.doctor._id,
  });
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
    message:
      "پزشک در زمان نوبت آماده بود و هزینه‌ی نوبت به او پرداخت شد. برای لغو رایگان، تا ۲۴ ساعت پیش از نوبت اقدام کنید.",
    link: `/dashboard/booking/${reservation._id}`,
  }).catch(() => {});
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
