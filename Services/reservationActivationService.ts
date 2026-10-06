import Reservation, { IReservation, VISIT_DISPUTE_HOURS } from "../Models/Reservation";
import { DoctorSessionType } from "../Models/DoctorSession";
import Chat from "../Models/Chat";
import CallRoom, { CallType } from "../Models/CallRoom";
import Notification from "../Models/Notification";
import { todayStart, tomorrowStart } from "../Lib/dateUtils";
import { addTehranDays, TEHRAN_TZ, tehranInstantOf } from "../Lib/tehranTime";
import { originateSipCall } from "../Lib/sipService";
import { getAppConfig } from "../Lib/appConfig";
import callService from "./Call/CallService";
import {
  markReservationPresent,
  handleReservationSuccess,
  handlePatientNoShow,
  handleDoctorNoShow,
  handleReservationError,
} from "./reservationProgressService";
import {
  notifyUpcomingReservationSms,
  notifyVisitConfirmSms,
  notifyReservationNoShowNudge,
} from "./reservationSmsService";
import { notifyWithSms, reservationSmsContext } from "./notificationSmsService";

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

// In-app deep-link to a reservation's detail page, scoped to the recipient's
// own panel - the patient dashboard and the doctor panel each have their own
// booking-detail route backed by their own (role-scoped) API endpoint, so a
// single reservation id resolves to two different paths depending on who's
// clicking.
const reservationLink = (
  reservation: IReservation,
  recipient: "patient" | "doctor",
): string =>
  recipient === "patient"
    ? `/dashboard/booking/${reservation._id}`
    : `/doctorpanel/booking/${reservation._id}`;

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
  await notifyBoth(reservation, (recipient) => ({
    title: "نوبت متنی شما آغاز شد",
    message: "می‌توانید اکنون گفتگوی متنی نوبت خود را شروع کنید.",
    // each side opens the chat in its own panel
    link:
      recipient === "patient"
        ? `/dashboard/chat/${chat._id}`
        : `/doctorpanel/chat/${chat._id}`,
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
  await notifyBoth(reservation, (recipient) => ({
    title: "نوبت تلفنی شما آغاز شد",
    message: "پزشک به‌زودی با شما تماس خواهد گرفت.",
    link: reservationLink(reservation, recipient),
  }));
};

const activateInPerson: ActivationHandler = async (reservation) => {
  await notifyBoth(reservation, (recipient) => ({
    title: "یادآوری نوبت حضوری",
    message:
      recipient === "patient"
        ? "نوبت حضوری شما هم‌اکنون در مطب شروع می‌شود."
        : "بیمار برای نوبت حضوری هم‌اکنون در مطب حاضر می‌شود.",
    link: reservationLink(reservation, recipient),
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
  // "phone" is retired (2026-10 decision: a phone consult is either the
  // VoIP call - sipCall - or the in-app call over mediasoup). A phone
  // reservation booked before that runs as a VoIP call, which marks both
  // parties present when they answer, so it is paid like any other visit.
  phone: activateSipCall,
};

// reservation.date is the midnight of the reservation's day (a day key,
// Lib/tehranTime.ts); start/end are minutes of Tehran wall-clock. The sweeps
// need the real instant: the Tehran day of the key at those minutes, so a
// 10:00 visit starts at 10:00 Tehran (06:30 UTC) whatever the server's zone
// and whichever midnight (UTC or Tehran) the key was saved at.
export const reservationStartTime = (reservation: Pick<IReservation, "date" | "start">): Date =>
  tehranInstantOf(reservation.date, reservation.start);

export const reservationEndTime = (reservation: Pick<IReservation, "date" | "end">): Date =>
  tehranInstantOf(reservation.date, reservation.end);

export const isDue = (reservation: Pick<IReservation, "date" | "start">, now: Date): boolean =>
  reservationStartTime(reservation).getTime() <= now.getTime();

export const runReservationActivationSweep = async (): Promise<void> => {
  const now = new Date();
  // up to the end of today in Tehran (both day-key conventions)
  const dueReservations = await Reservation.find({
    status: "pending",
    date: { $lt: tomorrowStart() },
  })
    .sort({ date: 1, start: 1 })
    .limit(MAX_RESERVATIONS_PER_RUN)
    .populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      { path: "patient" },
    ]);

  for (const reservation of dueReservations) {
    if (!isDue(reservation, now)) continue;
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
  const { reservationReminderMinutesBefore } = await getAppConfig();
  const reminderCutoff = new Date(
    now.getTime() + reservationReminderMinutesBefore * 60000,
  );
  // a reminder window can reach past Tehran midnight (a visit at 00:15)
  const candidates = await Reservation.find({
    status: "pending",
    reminderSentAt: { $exists: false },
    date: { $lt: addTehranDays(reminderCutoff, 1) },
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
      await notifyBoth(reservation, (recipient) => ({
        title: "یادآوری نوبت",
        message: `نوبت شما تا ${reservationReminderMinutesBefore} دقیقه دیگر آغاز می‌شود.`,
        link: reservationLink(reservation, recipient),
      }));
      // SMS channel for the same reminder - separate from the in-app/push
      // notifyBoth above, and never allowed to fail/block it (an SMS
      // gateway hiccup shouldn't stop reminderSentAt from being persisted).
      notifyUpcomingReservationSms(
        reservation,
        reservationReminderMinutesBefore,
      ).catch((err) =>
        console.log(
          `[reservationActivation] failed to send upcoming-reservation SMS for reservation ${reservation._id}:`,
          err,
        ),
      );
      reservation.reminderSentAt = now;
      reservation.reminderError = undefined;
      await reservation.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[reservationActivation] failed to send reminder for reservation ${reservation._id}:`,
        err,
      );
      reservation.reminderError = message;
      await reservation.save();
    }
  }
};

export const startReservationReminderJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationReminderSweep().catch(console.error);
  }, intervalMs);
};

// --- 24-hour / 2-hour reminders ---------------------------------------------
// On top of the "starts in N minutes" reminder above (2026-10 owner
// decision, the Doctolib pattern of a reminder the day before and another a
// few hours before - the main cut in no-shows): the patient gets an in-app
// notice and an SMS (notifyWithSms, events reservationReminderDayBeforePatient
// / reservationReminderTwoHoursPatient) 24 hours and 2 hours before the visit.
//
// - Exactly once per reservation and stage: the stage's marker
//   (reminder24hSentAt / reminder2hSentAt) is claimed with one atomic update
//   before anything is sent, so two ticks, two server instances or a restart
//   can never send it twice.
// - Only pending reservations: a cancelled one is never reminded. A
//   rescheduled one had its markers cleared by the move (doctor desk / admin
//   reschedule) and slotSetAt set, so it gets reminders for its new time.
// - A stage whose window had already opened when the slot was booked or
//   moved is skipped (the booking / reschedule notice just gave the time),
//   and the 24-hour one is dropped once the 2-hour window has opened (the
//   server was down meanwhile) - the patient never gets both at once.
// - Each stage can be switched off in the booking settings
//   (AppConfig.reservationReminder24hEnabled / reservationReminder2hEnabled).

type ReminderStage = {
  hours: number;
  // the stage stops being sent once the lead time is at or below this many
  // minutes (the next, closer reminder takes over)
  untilMinutes: (config: { reservationReminderMinutesBefore: number }) => number;
  marker: "reminder24hSentAt" | "reminder2hSentAt";
  enabled: "reservationReminder24hEnabled" | "reservationReminder2hEnabled";
  event: "reservationReminderDayBeforePatient" | "reservationReminderTwoHoursPatient";
  notification: (ctx: { doctorName: string; date: string; time: string }) => {
    title: string;
    message: string;
  };
};

export const RESERVATION_REMINDER_STAGES: ReminderStage[] = [
  {
    hours: 24,
    untilMinutes: () => 2 * 60,
    marker: "reminder24hSentAt",
    enabled: "reservationReminder24hEnabled",
    event: "reservationReminderDayBeforePatient",
    notification: (ctx) => ({
      title: "یادآوری نوبت",
      message: `نوبت شما با دکتر ${ctx.doctorName} در تاریخ ${ctx.date} ساعت ${ctx.time} است.`,
    }),
  },
  {
    hours: 2,
    untilMinutes: (config) =>
      Math.max(0, Number(config.reservationReminderMinutesBefore) || 0),
    marker: "reminder2hSentAt",
    enabled: "reservationReminder2hEnabled",
    event: "reservationReminderTwoHoursPatient",
    notification: (ctx) => ({
      title: "یادآوری نوبت",
      message: `نوبت شما با دکتر ${ctx.doctorName} ساعت ${ctx.time} آغاز می‌شود.`,
    }),
  },
];

// the visit's start instant inside a query: the Tehran day of the day key
// at its midnight, plus the start minutes (reservationStartTime in Mongo)
export const START_EXPR = {
  $add: [
    {
      $dateFromString: {
        dateString: { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: TEHRAN_TZ } },
        format: "%Y-%m-%d",
        timezone: TEHRAN_TZ,
      },
    },
    { $multiply: ["$start", 60000] },
  ],
};

export const runReservationStageReminderSweep = async (): Promise<void> => {
  const config = await getAppConfig();
  for (const stage of RESERVATION_REMINDER_STAGES) {
    if (config[stage.enabled] === false) continue;
    const now = new Date();
    const windowOpen = new Date(now.getTime() + stage.hours * 3600 * 1000);
    const windowClose = new Date(now.getTime() + stage.untilMinutes(config) * 60000);
    // date prefilter for the index: today up to the day the window ends
    const firstDay = todayStart();
    const candidates = await Reservation.find({
      status: "pending",
      [stage.marker]: { $exists: false },
      date: { $gte: addTehranDays(firstDay, -1), $lt: addTehranDays(windowOpen, 1) },
      $expr: {
        $and: [
          { $lte: [START_EXPR, windowOpen] },
          { $gt: [START_EXPR, windowClose] },
          // booked / moved before this stage's window opened
          {
            $lte: [
              { $ifNull: ["$slotSetAt", "$createdAt"] },
              { $subtract: [START_EXPR, stage.hours * 3600 * 1000] },
            ],
          },
        ],
      },
    })
      .select("_id date start")
      .sort({ date: 1, start: 1 })
      .limit(MAX_RESERVATIONS_PER_RUN)
      .lean();

    for (const candidate of candidates) {
      try {
        // the claim: only one sweep ever wins it, and only while the
        // reservation is still pending at the same time
        const claimed = await Reservation.findOneAndUpdate(
          {
            _id: candidate._id,
            status: "pending",
            date: candidate.date,
            start: candidate.start,
            [stage.marker]: { $exists: false },
          },
          { $set: { [stage.marker]: new Date() } },
          { new: true },
        )
          .select("_id")
          .lean();
        if (!claimed) continue;
        const ctx = await reservationSmsContext(candidate._id);
        if (!ctx) continue;
        await notifyWithSms(
          stage.event,
          ctx.patientUser,
          {
            reservationId: ctx.reservationId,
            doctorName: ctx.doctorName,
            date: ctx.date,
            time: ctx.time,
          },
          {
            phone: ctx.patientPhone,
            notification: {
              ...stage.notification(ctx),
              link: `/dashboard/booking/${ctx.reservationId}`,
            },
          },
        );
      } catch (err) {
        console.log(
          `[reservationActivation] failed to send the ${stage.hours}h reminder for reservation ${candidate._id}:`,
          err,
        );
      }
    }
  }
};

export const startReservationStageReminderJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationStageReminderSweep().catch(console.error);
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
  const candidates = await Reservation.find({
    status: { $in: ["pending", "active"] },
    date: { $lt: tomorrowStart() },
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
      if (reservation.sessionType === "inPerson" && !reservation.doctorPresentAt) {
        // In-person visit with no check-in (2026-10 decision): it counts as
        // done for the doctor - forgetting the check-in must not refund
        // every patient - unless the patient objects within
        // VISIT_DISPUTE_HOURS. The payout sits in its settlement hold
        // (Lib/payoutHold.ts) meanwhile, so an upheld objection can still
        // take it back. Doctolib/Zocdoc treat an unreported visit the same.
        reservation.status = "completed";
        reservation.autoCompleted = true;
        reservation.disputeDeadline = new Date(
          now.getTime() + VISIT_DISPUTE_HOURS * 60 * 60 * 1000,
        );
        await handleReservationSuccess(reservation);
        await Notification.create({
          user: reservation.user?._id ?? reservation.user,
          source: "System",
          title: "آیا ویزیت شدید؟",
          message: `نوبت حضوری شما انجام‌شده ثبت شد. اگر ویزیت انجام نشد، تا ${VISIT_DISPUTE_HOURS} ساعت از صفحه‌ی نوبت اعتراض کنید.`,
          link: reservationLink(reservation, "patient"),
        }).catch(() => {});
        notifyVisitConfirmSms(reservation).catch(() => {});
      } else if (reservation.status === "pending") {
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
      // the visit is over: close its text chat, or the patient could keep
      // messaging the doctor for free indefinitely (sendMessage refuses a
      // chat with closedAt)
      // same for a call: the booking room stays open while empty (see
      // CallService.handleEmptyRoom) and is ended here
      if (reservation.callRoom)
        await callService
          .endReservationCall(String(reservation.callRoom))
          .catch((err) =>
            console.log(
              `[reservationActivation] failed to end call of reservation ${reservation._id}:`,
              err,
            ),
          );
      if (reservation.chat)
        await Chat.updateOne(
          { _id: reservation.chat, closedAt: { $exists: false } },
          { $set: { closedAt: now } },
        ).catch((err) =>
          console.log(
            `[reservationActivation] failed to close chat of reservation ${reservation._id}:`,
            err,
          ),
        );
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

// --- Mid-session no-show nudge sweep ---------------------------------------
// Independent of the finalization sweep above (which only runs once a
// reservation's scheduled *end* time has passed): this one runs while a
// reservation is still "active" (in progress), and nudges by SMS whichever
// party hasn't been marked present yet, once enough time
// (reservationNoShowNudgeMinutesAfterStart) has passed since the
// reservation's *start* time. Each party is nudged at most once
// (doctorNoShowNudgeSentAt/patientNoShowNudgeSentAt guard against
// re-sending on every tick) - a party who shows up after being nudged just
// gets patientPresentAt/doctorPresentAt set as normal, no further action
// here. 2026-09 user decision (via AskUserQuestion): nudge the absent party
// mid-session, not a post-finalization self-notice and not a notice to the
// other party - see Services/reservationSmsService.ts's
// notifyReservationNoShowNudge.

export const runReservationNoShowNudgeSweep = async (): Promise<void> => {
  const now = new Date();
  const { reservationNoShowNudgeMinutesAfterStart } = await getAppConfig();
  const candidates = await Reservation.find({
    status: "active",
    date: { $lt: tomorrowStart() },
    $or: [
      { doctorPresentAt: { $exists: false } },
      { patientPresentAt: { $exists: false } },
    ],
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
    const endsAt = reservationEndTime(reservation);
    const nudgeCutoff = new Date(
      startsAt.getTime() + reservationNoShowNudgeMinutesAfterStart * 60000,
    );
    // Not yet due for a nudge, or the session is already over - the
    // finalization sweep owns it past that point.
    if (now < nudgeCutoff || now >= endsAt) continue;

    let changed = false;
    if (!reservation.doctorPresentAt && !reservation.doctorNoShowNudgeSentAt) {
      try {
        await notifyReservationNoShowNudge(reservation, "doctor");
        reservation.doctorNoShowNudgeSentAt = now;
        changed = true;
      } catch (err) {
        console.log(
          `[reservationActivation] failed to send doctor no-show nudge for reservation ${reservation._id}:`,
          err,
        );
      }
    }
    if (
      !reservation.patientPresentAt &&
      !reservation.patientNoShowNudgeSentAt
    ) {
      try {
        await notifyReservationNoShowNudge(reservation, "patient");
        reservation.patientNoShowNudgeSentAt = now;
        changed = true;
      } catch (err) {
        console.log(
          `[reservationActivation] failed to send patient no-show nudge for reservation ${reservation._id}:`,
          err,
        );
      }
    }
    if (changed) await reservation.save();
  }
};

export const startReservationNoShowNudgeJob = (intervalMs: number): void => {
  setInterval(() => {
    runReservationNoShowNudgeSweep().catch(console.error);
  }, intervalMs);
};
