import {
  notifyWithSms,
  reservationSmsContext,
  smsDate,
  smsTime,
} from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { saturdayBasedDay, todayStart } from "../Lib/dateUtils";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import { isPhone } from "../Lib/validators";
import { getPodiumIdentity, shahkar } from "../Lib/Podium";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { doctorSessionTypes, DoctorSessionType } from "../Models/DoctorSession";
import DoctorShift from "../Models/DoctorShift";
import DoctorTimeOff from "../Models/DoctorTimeOff";
import { blockedOn, overlapsBlocked, wholeDayOnly } from "../Lib/timeOff";
import { ensureDoctorPatient } from "../Lib/doctorPatient";
import DoctorPatient from "../Models/DoctorPatient";
import Reservation from "../Models/Reservation";
import User from "../Models/User";
import UserIdentity from "../Models/UserIdentity";
import UserRelative from "../Models/UserRelative";
import Notification from "../Models/Notification";
import { doctorSessionKindSettingsModelDict } from "./bookingController";
import { notifyNewReservation } from "../Services/reservationSmsService";
import { getBookingHorizonDays } from "../Lib/appConfig";

// The doctor's front desk (2026-10): what a secretary does at the counter or
// on the phone, after Doctolib Pro / Paziresh24 reception screens. Book a
// patient into a free slot (paid at the desk, not online), move a pending
// visit, and mark days off. Every route runs as the doctor (useDoctor), so
// the owner and a secretary with "mutateCalendar" both can.

const toAsciiDigits = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// "YYYY-MM-DD" -> local midnight (reservation.date is stored that way)
const dayStart = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};
const nextDay = (date: Date) => {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
};

// a whole day off (blocked hours only close their own slots, in daySlots)
const isDayOff = (doctor: unknown, day: Date) =>
  DoctorTimeOff.exists({ doctor, from: { $lte: day }, to: { $gte: day }, ...wholeDayOnly });

// every session of the doctor on that day (optionally one session type),
// marked free / taken / past; `except` is a reservation that never blocks
// itself (when moving it)
const daySlots = async (
  doctorId: unknown,
  day: Date,
  sessionType?: DoctorSessionType,
  except?: unknown,
) => {
  const [shifts, reservations, blocked] = await Promise.all([
    DoctorShift.find({
      doctor: doctorId,
      day: saturdayBasedDay(day.getDay()),
      ...(sessionType ? { sessionTypes: sessionType } : {}),
    })
      .populate({ path: "office", select: "name" })
      .lean(),
    Reservation.find({
      doctor: doctorId,
      status: { $ne: "cancelled" },
      date: { $gte: day, $lt: nextDay(day) },
      ...(except ? { _id: { $ne: except } } : {}),
    })
      .select("start end")
      .lean(),
    blockedOn(doctorId, day),
  ]);
  const now = Date.now();
  return shifts
    .flatMap((shift: any) =>
      getShiftSessionBounds(shift).map(([start, end]) => ({
        start,
        end,
        office: shift.office || null,
        sessionTypes: (shift.sessionTypes || []) as DoctorSessionType[],
        // hours the doctor blocked count as taken
        blocked: overlapsBlocked(blocked.ranges, start, end),
        taken:
          overlapsBlocked(blocked.ranges, start, end) ||
          reservations.some((x) => !(x.end <= start || x.start >= end)),
        past: day.getTime() + start * 60000 <= now,
      })),
    )
    .sort((a, b) => a.start - b.start);
};

const refreshDay = (doctor: any, day: Date) =>
  updateDoctorAvailability({ doctor, startDate: day, endDate: day }).catch(() => undefined);

// GET /doctor/desk/slots?date=YYYY-MM-DD[&sessionType=][&except=<id>]
export const getDeskSlots: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const day = typeof req.query.date === "string" ? dayStart(req.query.date) : null;
    if (!day) return next(new BadInputError("date"));
    const sessionType = doctorSessionTypes.find((t) => t === req.query.sessionType);
    const except =
      typeof req.query.except === "string" && isValidObjectId(req.query.except)
        ? req.query.except
        : undefined;
    const dayOff = !!(await isDayOff(req.doctor._id, day));
    const data = dayOff ? [] : await daySlots(req.doctor._id, day, sessionType, except);
    res.status(200).json({ message: "getDeskSlots", data: { dayOff, slots: data } });
  },
);

// the patient: an identity we already have (birth date must match), or a
// new one verified with the civil registry and the phone operator (the same
// checks as a patient adding a relative)
const findOrVerifyIdentity = async (
  input: { nationalId: string; birthDate: Date; phone: string },
  requester: any,
) => {
  const existing = await UserIdentity.findOne({ nationalId: input.nationalId });
  if (existing) {
    // stored birth dates come at midnight UTC or Tehran: either day counts
    const ymd = (d: Date, timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(d));
    const wanted = ymd(input.birthDate, "Asia/Tehran");
    const stored = [ymd(existing.dateOfbirth, "UTC"), ymd(existing.dateOfbirth, "Asia/Tehran")];
    if (!stored.includes(wanted))
      throw new AppError("تاریخ تولد با کد ملی نمی‌خواند", 400);
    return existing;
  }
  const identity = await getPodiumIdentity({
    nationalId: input.nationalId,
    birthdate: input.birthDate,
    requester,
  });
  if (!identity.status) throw new AppError(identity.error, 400);
  const match = await shahkar({ phone: input.phone, nationalCode: input.nationalId, requester });
  if (!match.status) throw new AppError(match.error, 400);
  const d = identity.data;
  return UserIdentity.create({
    nationalId: d.nationalCode,
    givenName: d.firstName,
    lastName: d.lastName,
    gender: d.gender.toLowerCase(),
    dateOfbirth: input.birthDate,
    fatherName: d.fatherName,
    identificationNumber: d.identificationNumber,
    identificationSerialCode: d.identificationSerialCode,
    identificationSerialNumber: d.identificationSerialNumber,
    birthPlaceCode: d.birthPlaceCode,
    birthPlace: d.birthPlace,
    phones: [input.phone],
  });
};

const deskBookingSchema = z.strictObject({
  // a returning patient (one of this doctor's earlier visits): no ID check
  // again; otherwise phone + national ID + birth date
  identity: z.string().max(40).optional(),
  phone: z.string().max(20).optional(),
  nationalId: z.string().max(12).optional(),
  birthDate: z.string().max(40).optional(),
  date: z.string().min(8).max(40),
  start: z.coerce.number().int().min(0).max(24 * 60),
  end: z.coerce.number().int().min(0).max(24 * 60),
  sessionType: z.enum(doctorSessionTypes),
});

// GET /doctor/desk/patients?q= - this doctor's earlier patients (by name,
// phone or national ID) for a quick desk booking of a returning patient
export const searchDeskPatients: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const q = toAsciiDigits(typeof req.query.q === "string" ? req.query.q : "").trim().slice(0, 40);
    const rows = await Reservation.aggregate([
      { $match: { doctor: req.doctor._id, patient: { $ne: null } } },
      { $sort: { date: -1 } },
      { $group: { _id: "$patient", user: { $first: "$user" }, lastDate: { $first: "$date" } } },
      { $sort: { lastDate: -1 } },
      { $limit: 500 },
      { $lookup: { from: "useridentities", localField: "_id", foreignField: "_id", as: "identity" } },
      { $unwind: "$identity" },
      { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "booker" } },
      { $unwind: { path: "$booker", preserveNullAndEmptyArrays: true } },
    ]);
    const norm = (v: unknown) => toAsciiDigits(String(v || "")).toLowerCase();
    const phoneQ = q.replace(/^0/, "98");
    const data = rows
      .filter((r: any) => {
        if (!q) return true;
        const name = norm(`${r.identity.givenName || ""} ${r.identity.lastName || ""}`);
        const phone = norm(r.booker?.phone);
        return name.includes(norm(q)) || (q.length >= 4 && (phone.includes(phoneQ) || phone.includes(q))) || (q.length >= 4 && norm(r.identity.nationalId).startsWith(q));
      })
      .slice(0, 8)
      .map((r: any) => ({
        identity: r._id,
        name: [r.identity.givenName, r.identity.lastName].filter(Boolean).join(" "),
        phone: r.booker?.phone || "",
        // only the last digits: enough to tell two namesakes apart
        nationalIdTail: r.identity.nationalId ? String(r.identity.nationalId).slice(-4) : "",
        lastDate: r.lastDate,
      }));
    res.status(200).json({ message: "searchDeskPatients", data });
  },
);

// POST /doctor/desk/reservation
// A booking made at the desk or on the phone. Nothing is charged online:
// the patient pays at the visit, so the reservation carries no payment
// (total 0, deskFee = the listed price) and a cancel never refunds money
// that was never paid; the doctor is paid at the desk, not by the platform.
export const createDeskReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor || !req.user) return next(new MiddlewareError());
    const parsed = deskBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const day = dayStart(input.date);
    if (!day) return next(new BadInputError("date"));
    if (day < todayStart())
      return next(new BadInputError("امکان ثبت نوبت در روز گذشته وجود ندارد"));
    if (await isDayOff(req.doctor._id, day))
      return next(new AppError("پزشک در این روز نوبت نمی‌دهد", 400));

    const slots = await daySlots(req.doctor._id, day, input.sessionType);
    const slot = slots.find((s) => s.start === input.start && s.end === input.end);
    if (!slot || !slot.office) return next(new NotFoundError("نوبت"));
    if (slot.past) return next(new AppError("ساعت این نوبت گذشته است", 400));
    if (slot.taken) return next(new AppError("این جلسه قبلا رزرو شده است", 400));

    let identity: any;
    let user: any;
    if (input.identity) {
      // returning patient: someone this doctor has already seen; the visit
      // goes to the account that booked them last time
      if (!isValidObjectId(input.identity)) return next(new NotFoundError("بیمار"));
      const last = await Reservation.findOne({ doctor: req.doctor._id, patient: input.identity })
        .sort({ date: -1 })
        .select("user patient");
      identity = await UserIdentity.findById(input.identity);
      // or the own identity of an account on the doctor's patient list
      const listed =
        !last && identity?.user
          ? await DoctorPatient.exists({ doctor: req.doctor._id, user: identity.user })
          : null;
      if (!last && !listed) return next(new NotFoundError("بیمار"));
      user = await User.findById(last ? last.user : identity?.user);
      if (!identity || !user) return next(new NotFoundError("بیمار"));
      if (user.status === "deleted" || user.status === "suspended")
        return next(new AppError("حساب این شماره فعال نیست", 400));
    } else {
      const phone = isPhone(toAsciiDigits(input.phone || ""));
      if (!phone) return next(new AppError("شماره موبایل معتبر نیست", 400));
      const nationalId = toAsciiDigits(input.nationalId || "").trim();
      if (!/^\d{10}$/.test(nationalId)) return next(new AppError("کد ملی معتبر نیست", 400));
      const birthDate = dayStart(input.birthDate || "");
      if (!birthDate) return next(new BadInputError("date"));
      identity = await findOrVerifyIdentity({ nationalId, birthDate, phone }, req.user);
      // the booking account: whoever owns that mobile number (created if
      // new, they log in with it later and see the visit)
      user = await User.findOne({ phone });
      if (!user) user = await User.create({ phone });
      if (user.status === "deleted" || user.status === "suspended")
        return next(new AppError("حساب این شماره فعال نیست", 400));
      const ownIdentity = await UserIdentity.findOne({ user: user._id }).select("_id");
      if (!identity.user && !ownIdentity) {
        identity.user = user._id as any;
        await identity.save();
      } else if (String((identity.user as any)?._id ?? identity.user ?? "") !== String(user._id)) {
        // booking for someone else (a child, a parent): linked as a relative
        await UserRelative.updateOne(
          { user: user._id, other: identity._id },
          { $setOnInsert: { user: user._id, other: identity._id } },
          { upsert: true },
        );
      }
    }

    const settings = await (
      doctorSessionKindSettingsModelDict[input.sessionType] as Model<any>
    )
      .findOne({ doctor: req.doctor._id })
      .select("price")
      .lean<{ price?: number }>();

    const reservation = await Reservation.create({
      user: user._id,
      patient: identity._id,
      doctor: req.doctor._id,
      date: day,
      start: slot.start,
      end: slot.end,
      office: slot.office._id,
      sessionType: input.sessionType,
      subtotal: 0,
      tax: 0,
      total: 0,
      source: "desk",
      deskFee: settings?.price || 0,
      status: "pending",
    });
    // a parallel booking may have taken the slot meanwhile
    const clash = await Reservation.exists({
      _id: { $ne: reservation._id },
      doctor: req.doctor._id,
      status: { $ne: "cancelled" },
      date: { $gte: day, $lt: nextDay(day) },
      start: { $lt: slot.end },
      end: { $gt: slot.start },
    });
    if (clash) {
      await Reservation.deleteOne({ _id: reservation._id });
      return next(new AppError("این جلسه قبلا رزرو شده است", 400));
    }
    await ensureDoctorPatient(user._id, req.doctor._id);
    res.status(200).json({ message: "createDeskReservation", data: { _id: reservation._id } });

    refreshDay(req.doctor, day);
    const forSms = await Reservation.findById(reservation._id).populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      { path: "patient", populate: { path: "user" } },
    ]);
    if (forSms) notifyNewReservation(forSms).catch(() => undefined);
  },
);

const moveSchema = z.strictObject({
  date: z.string().min(8).max(40),
  start: z.coerce.number().int().min(0).max(24 * 60),
  end: z.coerce.number().int().min(0).max(24 * 60),
});

// POST /doctor/reservation/:nodeId/move
// Moves a pending visit to another free session of the same session type
// (the same checks as booking); the price paid is kept, the patient is told.
export const moveReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = moveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError("نوبت"));
    const day = dayStart(parsed.data.date);
    if (!day) return next(new BadInputError("date"));
    const r = await Reservation.findOne({ _id: nodeId, doctor: req.doctor._id });
    if (!r) return next(new NotFoundError("نوبت"));
    if (r.status !== "pending")
      return next(new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400));
    if (
      day.getTime() === new Date(r.date).getTime() &&
      parsed.data.start === r.start &&
      parsed.data.end === r.end
    )
      return next(new AppError("زمان جدید با زمان فعلی نوبت یکی است", 400));
    if (await isDayOff(req.doctor._id, day))
      return next(new AppError("پزشک در این روز نوبت نمی‌دهد", 400));
    const slots = await daySlots(req.doctor._id, day, r.sessionType, r._id);
    const slot = slots.find((s) => s.start === parsed.data.start && s.end === parsed.data.end);
    if (!slot) return next(new NotFoundError("نوبت"));
    if (slot.past) return next(new AppError("ساعت این نوبت گذشته است", 400));
    if (slot.taken) return next(new AppError("این جلسه قبلا رزرو شده است", 400));

    const from = { date: r.date, start: r.start, end: r.end, office: r.office };
    const moved = await Reservation.findOneAndUpdate(
      { _id: r._id, status: "pending" },
      {
        $set: {
          date: day,
          start: slot.start,
          end: slot.end,
          ...(slot.office?._id ? { office: slot.office._id } : {}),
          slotSetAt: new Date(),
        },
        // the reminder and nudges belong to the old time
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
    );
    if (!moved)
      return next(new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400));
    const clash = await Reservation.exists({
      _id: { $ne: r._id },
      doctor: req.doctor._id,
      status: { $ne: "cancelled" },
      date: { $gte: day, $lt: nextDay(day) },
      start: { $lt: slot.end },
      end: { $gt: slot.start },
    });
    if (clash) {
      await Reservation.updateOne(
        { _id: r._id },
        {
          $set: {
            date: from.date,
            start: from.start,
            end: from.end,
            office: (from.office as any)?._id ?? from.office,
          },
        },
      );
      return next(new AppError("این جلسه قبلا رزرو شده است", 400));
    }
    res.status(200).json({ message: "moveReservation" });

    refreshDay(req.doctor, new Date(from.date));
    refreshDay(req.doctor, day);
    await Notification.create({
      user: (r.user as any)?._id ?? r.user,
      source: "System",
      title: "زمان نوبت شما تغییر کرد",
      message: "مطب زمان نوبت شما را تغییر داد؛ زمان جدید را در صفحه‌ی نوبت ببینید.",
      link: `/dashboard/booking/${r._id}`,
    }).catch(() => undefined);
    const ctx = await reservationSmsContext(r._id).catch(() => null);
    if (ctx)
      notifyWithSms(
        "reservationRescheduledPatient",
        ctx.patientUser,
        {
          reservationId: ctx.reservationId,
          doctorName: ctx.doctorName,
          date: smsDate(day),
          time: smsTime(slot.start),
        },
        { phone: ctx.patientPhone },
      );
  },
);

// ------------------------------------------------------------ days off

// GET /doctor/timeoff - current and future days off
export const getTimeOff: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorTimeOff.find({ doctor: req.doctor._id, to: { $gte: todayStart() } })
      .sort({ from: 1 })
      .lean();
    res.status(200).json({ message: "getTimeOff", data });
  },
);

const timeOffSchema = z.strictObject({
  from: z.string().min(8).max(40),
  to: z.string().min(8).max(40),
  note: z.string().trim().max(200).optional(),
  // both set: only these hours are blocked on each day (minutes, Tehran)
  startMin: z.number().int().min(0).max(24 * 60).optional(),
  endMin: z.number().int().min(0).max(24 * 60).optional(),
});

// POST /doctor/timeoff - adds days off. Visits already booked on them stay
// (the patient chose them); the answer counts them so the desk can move or
// cancel each one.
export const addTimeOff: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = timeOffSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const from = dayStart(parsed.data.from);
    const to = dayStart(parsed.data.to);
    if (!from || !to) return next(new BadInputError("date"));
    if (to < from) return next(new AppError("تاریخ پایان باید بعد از تاریخ شروع باشد", 400));
    if (to < todayStart()) return next(new BadInputError("امکان ثبت در روز گذشته وجود ندارد"));
    const { startMin, endMin } = parsed.data;
    const partial = startMin !== undefined || endMin !== undefined;
    if (partial && !(startMin !== undefined && endMin !== undefined && endMin > startMin))
      return next(new AppError("ساعت پایان هر بازه باید بعد از ساعت شروع آن باشد", 400));
    const created = await DoctorTimeOff.create({
      doctor: req.doctor._id,
      from,
      to,
      note: parsed.data.note || undefined,
      ...(partial ? { startMin, endMin } : {}),
    });
    // visits already booked inside the blocked days / hours
    const booked = await Reservation.countDocuments({
      doctor: req.doctor._id,
      status: "pending",
      date: { $gte: from, $lt: nextDay(to) },
      ...(partial ? { start: { $lt: endMin }, end: { $gt: startMin } } : {}),
    });
    res.status(200).json({ message: "addTimeOff", data: { _id: created._id, booked } });
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + (await getBookingHorizonDays()));
    if (from <= horizon)
      updateDoctorAvailability({
        doctor: req.doctor,
        startDate: from < todayStart() ? todayStart() : from,
        endDate: to < horizon ? to : horizon,
      }).catch(() => undefined);
  },
);

// DELETE /doctor/timeoff/:nodeId - the days are bookable again
export const removeTimeOff: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const node = await DoctorTimeOff.findOneAndDelete({ _id: nodeId, doctor: req.doctor._id });
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "removeTimeOff" });
    const today = todayStart();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + (await getBookingHorizonDays()));
    const start = new Date(node.from) < today ? today : new Date(node.from);
    const end = new Date(node.to) > horizon ? horizon : new Date(node.to);
    if (start <= end)
      updateDoctorAvailability({ doctor: req.doctor, startDate: start, endDate: end }).catch(
        () => undefined,
      );
  },
);

