import Reservation, { IReservation } from "../Models/Reservation";
import { DoctorSessionType } from "../Models/DoctorSession";
import Chat from "../Models/Chat";
import CallRoom, { CallType } from "../Models/CallRoom";
import Notification from "../Models/Notification";
import { todayStart } from "../Lib/dateUtils";
import { originateSipCall } from "../Lib/sipService";

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
  // Fire-and-forget: hand the call off to the Asterisk/ARI box and don't
  // wait for or track ringing/answer/hangup here.
  originateSipCall(docPhone, patPhone).catch((err) => {
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
