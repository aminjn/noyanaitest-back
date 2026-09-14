import mongoose from "mongoose";
import Reservation, {
  IReservation,
  ReservationParty,
} from "../Models/Reservation";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";

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

// Doctor was present, patient never showed.
export const handlePatientNoShow = async (
  reservation: IReservation,
): Promise<void> => {
  // TODO: implement patient-no-show actions.
};

// Patient was present, doctor never showed.
export const handleDoctorNoShow = async (
  reservation: IReservation,
): Promise<void> => {
  // TODO: implement doctor-no-show actions.
};

// Reservation could not be resolved cleanly: activation never managed to
// open a channel (dispatchError), or the session ended with neither party
// ever marked present.
export const handleReservationError = async (
  reservation: IReservation,
): Promise<void> => {
  // TODO: implement error/unknown-failure actions.
};
