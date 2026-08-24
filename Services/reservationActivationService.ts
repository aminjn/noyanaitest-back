import Reservation, { IReservation } from "../Models/Reservation";
import { DoctorSessionType } from "../Models/DoctorSession";
import Chat from "../Models/Chat";
import CallRoom, { CallType } from "../Models/CallRoom";
import Notification from "../Models/Notification";
import { todayStart } from "../Lib/dateUtils";
import { originateSipCall } from "../Lib/sipService";
import { getAppConfig } from "../Lib/appConfig";
import {
  markReservationPresent,
  handleReservationSuccess,
  handlePatientNoShow,
  handleDoctorNoShow,
  handleReservationError,
} from "./reservationProgressService";

// Cap how many reservations a single sweep handles, so a large backlog can't
// block the event loop for too long. Any leftovers are picked up on the next
// tick (mirrors Services/slugGenerationService.ts).
const MAX_RESERVATIONS_PER_RUN = 200;

type ActivationHandler = (reservation: IReservation) => Promise<void>;

const doctorUserId = (reservation: IReservation) =>
  reservation.doctor.user?._id;

const patientPhone = (reservation: IReservation): string | undefined =>
  reservation.patient.phones?.[0] || reservation.user.phone;

type NotificationContent = { title: string; message: string; link?: string };

// Creates one "System" notification for the patient (reservation.user, the
// account that made the booking) and one for the doctor's linked user
// account, if it has one.
const notifyBoth = async (
  reservation: IReservation,
  build: (recipient: "patient" | "doctor") => NotificationContent,
): Promise<void> => {
  const docUserId = doctorUserId(reservation);
  const docs = [
    { user: reservation.user._id, ...build("patient"), source: "System" },
    ...(docUserId
      ? [{ user: docUserId, ...build("doctor"), source: "System" }]
      : []),
  ];
  await Notification.insertMany(docs);
};

const activateTextChat: ActivationHandler = async (reservation) => {
  const docUserId = doctorUserId(reservation);
  if (!docUserId) throw new Error("Doctor has no linked user account");
  const chat = await Chat.create({
    participants: [reservation.user._id, docUserId],
    opensAt: new Date(),
    reservation: reservation._id,
  });
  reservation.chat = chat._id as unknown as IReservation["chat"];
  await notifyBoth(reservation, () => ({
    title: "نوبت متنی شما آغاز شد",
    message: "می‌توانید اکنون گفتگوی متنی نوبت خود را شروع کنید.",
    link: `/dashboard/chat/${chat._id}`,
  }));
};

const activateCall =
  (callType: CallType): ActivationHandler =>
  async (reservation) => {
    const docUserId = doctorUserId(reservation);
    if (!docUserId) throw new Error("Doctor has no linked user account");
    const room = await CallRoom.create({
      participants: [reservation.user._id, docUserId],
      callType,
      source: "booking",
      reservation: reservation._id,
    });
    reservation.callRoom = room._id as unknown as IReservation["callRoom"];
    await notifyBoth(reservation, () => ({
      title:
        callType === "video"
          ? "نوبت تصویری شما آغاز شد"
          : "نوبت صوتی شما آغاز شد",
      message: "می‌توانید اکنون وارد تماس نوبت خود شوید.",
      link: `/call/${room._id}`,
    }));
  };

const activateSipCall: ActivationHandler = async (reservation) => {
  const docPhone = reservation.doctor.user?.phone;
  const patPhone = patientPhone(reservation);
  if (!docPhone || !patPhone)
    throw new Error("Missing phone number for sipCall dispatch");
  // Fire-and-forget from the sweep's point of view (it doesn't await the
  // call being answered), but we do keep the promise around to persist the
  // ARI ids once known, and each leg's onLegAnswered callback marks that
  // party present on the reservation as soon as it answers - this is what
  // lets the finalization sweep later tell a sipCall patient/doctor no-show
  // apart from a real success.
  originateSipCall(docPhone, patPhone, (leg, _channelId) => {
    markReservationPresent(reservation._id, leg).catch((err) =>
      console.log(
        `[reservationActivation] failed to mark ${leg} present for reservation ${reservation._id}:`,
        err,
      ),
    );
  })
    .then((handles) =>
      Reservation.updateOne(
        { _id: reservation._id },
        {
          $set: {
            sipBridgeId: handles.bridgeId,
            sipDoctorChannelId: handles.doctorChannelId,
            sipPatientChannelId: handles.patientChannelId,
          },
        },
      ),
    )
    .catch((err) => {
      console.log(
        `[reservationActivation] sipCall originate failed for reservation ${reservation._id}:`,
        err,
      );
    });
  await notifyBoth(reservation, () => ({
    title: "نوبت تلفنی شما آغاز شد",
    message: "پزشک به‌زودی با شما تماس خواهد گرفت.",
  }));
};

const activateInPerson: ActivationHandler = async (reservation) => {
  await notifyBoth(reservation, (recipient) => ({
    title: "یادآوری نوبت حضوری",
    message:
      recipient === "patient"
        ? "نوبت حضوری شما هم‌اکنون در مطب شروع می‌شود."
        : "بیمار برای نوبت حضوری هم‌اکنون در مطب حاضر می‌شود.",
  }));
};

const activationHandlerBySessionType: Record<
  DoctorSessionType,
  ActivationHandler
> = {
  textChat: activateTextChat,
  voiceCall: activateCall("voice"),
  videoCall: activateCall("video"),
  sipCall: activateSipCall,
  inPerson: activateInPerson,
  // "phone" wasn't one of the 5 session types this flow was designed for -
  // treated as a reminder-only no-op for now. Flag to product/eng before
  // relying on this: it may need its own sipCall-style dispatch instead.
  phone: activateInPerson,
};

const isDue = (
  reservation: IReservation,
  now: Date,
  todaysStart: Date,
): boolean => {
  if (reservation.date.getTime() < todaysStart.getTime()) return true;
  if (reservation.date.getTime() > todaysStart.getTime()) return false;
  const minutesNow = Math.floor(
    (now.getTime() - todaysStart.getTime()) / 60000,
  );
  return reservation.start <= minutesNow;
};

// reservation.date is stored as midnight of the reservation's day (see
// dateStartOfDay); start/end are minutes-from-midnight. Both sweeps below
// need the actual wall-clock instant, not just "is it today yet".
const reservationStartTime = (reservation: IReservation): Date =>
  new Date(reservation.date.getTime() + reservation.start * 60000);

const reservationEndTime = (reservation: IReservation): Date =>
  new Date(reservation.date.getTime() + reservation.end * 60000);

export const runReservationActivationSweep = async (): Promise<void> => {
  const now = new Date();
  const todaysStart = todayStart();
  const dueReservations = await Reservation.find({
    status: "pending",
    date: { $lte: todaysStart },
  })
    .sort({ date: 1, start: 1 })
    .limit(MAX_RESERVATIONS_PER_RUN)
    .populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      { path: "patient" },
    ]);

  for (const reservation of dueReservations) {
    if (!isDue(reservation, now, todaysStart)) continue;
    const handler = activationHandlerBySessionType[reservation.sessionType];
    try {
      await handler(reservation);
      reservation.status = "active";
      reservation.activatedAt = now;
      reservation.dispatchError = undefined;
      await reservation.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[reservationActivation] failed to activate reservation ${reservation._id}:`,
        err,
      );
      reservation.dispatchError = message;
      await reservation.save();
    }
  }
};

export const startReservationActivationJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationActivationSweep().catch(console.error);
  }, intervalMs);
};

// --- Reminder sweep -------------------------------------------------------
// Sends the "your reservation starts in N minutes" notification once per
// reservation, N (RESERVATION_REMINDER_MINUTES_BEFORE) minutes before it's
// due. Runs independently of the activation sweep above so the two
// intervals can be tuned separately.

export const runReservationReminderSweep = async (): Promise<void> => {
  const now = new Date();
  const todaysStart = todayStart();
  const { reservationReminderMinutesBefore } = await getAppConfig();
  const reminderCutoff = new Date(
    now.getTime() + reservationReminderMinutesBefore * 60000,
  );
  const candidates = await Reservation.find({
    status: "pending",
    reminderSentAt: { $exists: false },
    date: { $lte: todaysStart },
  })
    .sort({ date: 1, start: 1 })
    .limit(MAX_RESERVATIONS_PER_RUN)
    .populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      { path: "patient" },
    ]);

  for (const reservation of candidates) {
    const startsAt = reservationStartTime(reservation);
    // Already started (or overdue) - the activation sweep owns it now, a
    // reminder no longer makes sense. Not yet inside the reminder window -
    // leave it for a later tick.
    if (startsAt <= now || startsAt > reminderCutoff) continue;
    try {
      await notifyBoth(reservation, () => ({
        title: "یادآوری نوبت",
        message: `نوبت شما تا ${reservationReminderMinutesBefore} دقیقه دیگر آغاز می‌شود.`,
      }));
      reservation.reminderSentAt = now;
      await reservation.save();
    } catch (err) {
      console.log(
        `[reservationActivation] failed to send reminder for reservation ${reservation._id}:`,
        err,
      );
    }
  }
};

export const startReservationReminderJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationReminderSweep().catch(console.error);
  }, intervalMs);
};

// --- Finalization sweep ----------------------------------------------------
// Once a reservation's scheduled end time has passed, decides what actually
// happened and fires exactly one outcome trigger from
// Services/reservationProgressService.ts:
//   - both parties were present at some point       -> success
//   - only the doctor was present                    -> patient no-show
//   - only the patient was present                    -> doctor no-show
//   - activation never opened a channel, or neither
//     party ever showed                               -> error/unknown
// The actions those triggers perform are deliberately left as TODOs for
// now - this sweep is just the piece that decides which one applies and
// calls it.

export const runReservationFinalizationSweep = async (): Promise<void> => {
  const now = new Date();
  const todaysStart = todayStart();
  const candidates = await Reservation.find({
    status: { $in: ["pending", "active"] },
    date: { $lte: todaysStart },
  })
    .sort({ date: 1, start: 1 })
    .limit(MAX_RESERVATIONS_PER_RUN)
    .populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      { path: "patient" },
    ]);

  for (const reservation of candidates) {
    const endsAt = reservationEndTime(reservation);
    if (endsAt > now) continue; // session isn't over yet

    try {
      if (reservation.status === "pending") {
        // Never even got dispatched (activation kept failing, or the
        // server was down through the whole window) - the "unknown error"
        // bucket, not a no-show either party can be blamed for.
        reservation.status = "error";
        await handleReservationError(reservation);
      } else if (reservation.patientPresentAt && reservation.doctorPresentAt) {
        reservation.status = "completed";
        await handleReservationSuccess(reservation);
      } else if (reservation.doctorPresentAt && !reservation.patientPresentAt) {
        reservation.status = "noShow";
        reservation.noShowParty = "patient";
        await handlePatientNoShow(reservation);
      } else if (reservation.patientPresentAt && !reservation.doctorPresentAt) {
        reservation.status = "noShow";
        reservation.noShowParty = "doctor";
        await handleDoctorNoShow(reservation);
      } else {
        // Channel opened but neither side was ever marked present - not a
        // no-show we can pin on one party. Treated as the error/unknown
        // bucket until product defines a distinct "both no-show" outcome.
        reservation.status = "error";
        await handleReservationError(reservation);
      }
      reservation.finalizedAt = now;
      await reservation.save();
    } catch (err) {
      console.log(
        `[reservationActivation] failed to finalize reservation ${reservation._id}:`,
        err,
      );
    }
  }
};

export const startReservationFinalizationJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationFinalizationSweep().catch(console.error);
  }, intervalMs);
};
