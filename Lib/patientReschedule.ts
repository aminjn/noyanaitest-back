import Reservation, { IReservation } from "../Models/Reservation";
import DoctorProfile from "../Models/DoctorProfile";
import Notification from "../Models/Notification";
import AppError, { NotFoundError } from "./AppError";
import { bookableDays } from "./bookingFlow";
import { addTehranDays, fromTehranWallClock, tehranYmd } from "./tehranTime";
import updateDoctorAvailability from "./updateDoctorAvailablity";
import { freeCancelHoursFor } from "./patientPro";
import { getPatientFreeCancelHours, patientCanCancel } from "../Services/reservationCancelService";
import { notifyWithSms, reservationSmsContext, smsDate, smsTime } from "../Services/notificationSmsService";

// The patient's own reschedule (2026-10 booking redesign, Doctolib /
// Zocdoc "move appointment"): a pending visit moves to another free slot of
// the same visit type, inside the same free-change window as a free cancel
// (later than that the office has to move it). The price paid is kept.
// Used by POST /user/reservation/:id/reschedule and by the one-tap "move
// my appointment" of an earlier-slot waitlist offer (Lib/waitlist.ts).
// Moving away frees the old slot: the availability regeneration runs the
// waitlist for others (Lib/updateDoctorAvailablity.ts).

// can this reservation still be moved by its patient right now
export const patientCanMove = async (r: IReservation, userId: unknown, now = new Date()) => {
  const hours = await freeCancelHoursFor(userId as never, await getPatientFreeCancelHours());
  return { ok: r.status === "pending" && patientCanCancel(r, now, hours), hours };
};

export const reschedulePatientReservation = async ({
  userId,
  reservationId,
  date,
  start,
  end,
  office,
}: {
  userId: unknown;
  reservationId: unknown;
  date: string;
  start: number;
  end: number;
  // an earlier-slot offer keeps the office it was found at
  office?: string | null;
}) => {
  const r = await Reservation.findOne({ _id: reservationId, user: userId });
  if (!r) throw new NotFoundError("نوبت");
  if (r.status !== "pending") throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400);
  const { ok, hours } = await patientCanMove(r as unknown as IReservation, userId);
  if (!ok)
    throw new AppError(
      "تغییر آنلاین زمان نوبت فقط تا ${1} ساعت پیش از زمان نوبت ممکن است".replace("${1}", hours.toLocaleString("fa-IR")),
      400,
    );
  if (tehranYmd(r.date) === date && r.start === start && r.end === end)
    throw new AppError("زمان جدید با زمان فعلی نوبت یکی است", 400);
  const { days } = await bookableDays({
    doctorId: r.doctor,
    sessionType: r.sessionType,
    ...(office ? { office } : {}),
  });
  const slot = days.find((d) => d.ymd === date)?.bounds.find((b) => b.start === start && b.end === end);
  if (!slot) throw new AppError("این جلسه قبلا رزرو شده است", 400);
  const day = fromTehranWallClock(date, 0);
  const from = { date: r.date, start: r.start, end: r.end, office: r.office };
  const moved = await Reservation.findOneAndUpdate(
    { _id: r._id, status: "pending" },
    {
      $set: { date: day, start: slot.start, end: slot.end, office: slot.office, slotSetAt: new Date() },
      // the reminders and nudges belong to the old time
      $unset: {
        reminderSentAt: 1,
        reminder24hSentAt: 1,
        reminder2hSentAt: 1,
        reminderError: 1,
        doctorNoShowNudgeSentAt: 1,
        patientNoShowNudgeSentAt: 1,
        dispatchError: 1,
      },
    },
    { new: true },
  );
  if (!moved) throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400);
  // a parallel booking may have taken the new slot meanwhile
  const clash = await Reservation.exists({
    _id: { $ne: r._id },
    doctor: r.doctor,
    status: { $ne: "cancelled" },
    date: { $gte: day, $lt: addTehranDays(day, 1) },
    start: { $lt: slot.end },
    end: { $gt: slot.start },
  });
  if (clash) {
    await Reservation.updateOne({ _id: r._id }, { $set: { date: from.date, start: from.start, end: from.end, office: from.office } });
    throw new AppError("این جلسه قبلا رزرو شده است", 400);
  }

  // after the answer: the doctor is told, both days are regenerated (the
  // freed one wakes the waitlist)
  const after = async () => {
    const doctor = await DoctorProfile.findById(r.doctor);
    if (doctor) {
      await updateDoctorAvailability({ doctor, startDate: day, endDate: day }).catch(() => undefined);
      await updateDoctorAvailability({ doctor, startDate: from.date, endDate: from.date }).catch(() => undefined);
      if (doctor.user)
        await Notification.create({
          user: doctor.user,
          source: "System",
          title: "زمان یک نوبت تغییر کرد",
          message: "بیمار زمان نوبتش را تغییر داد؛ زمان جدید را در صفحه‌ی نوبت ببینید.",
          link: `/doctorpanel/booking/${r._id}`,
        }).catch(() => undefined);
    }
    const ctx = await reservationSmsContext(r._id).catch(() => null);
    if (ctx?.doctorUser)
      notifyWithSms("reservationRescheduledDoctor", ctx.doctorUser, {
        reservationId: ctx.reservationId,
        patientName: ctx.patientName,
        date: smsDate(day),
        time: smsTime(slot.start),
      });
  };
  return { moved, after };
};
