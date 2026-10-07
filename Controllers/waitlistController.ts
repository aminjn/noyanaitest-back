import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { doctorSessionTypes } from "../Models/DoctorSession";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import WaitlistEntry, { waitlistKeyFor } from "../Models/WaitlistEntry";
import Reservation, { IReservation } from "../Models/Reservation";
import UserIdentity from "../Models/UserIdentity";
import UserRelative from "../Models/UserRelative";
import { patientCanMove, reschedulePatientReservation } from "../Lib/patientReschedule";
import { getBookingHorizonDays } from "../Lib/appConfig";
import { sessionSettingsModels } from "../Lib/bookingFlow";
import { addDaysYmd, fromTehranWallClock, tehranInstantOf, tehranYmd } from "../Lib/tehranTime";
import {
  freeSlotsFor,
  MAX_ACTIVE_ENTRIES,
  newWaitlistCode,
  queueWaitlistMatch,
  slotKey,
} from "../Lib/waitlist";

// «وقتی نوبت خالی شد خبرم کن» (Lib/waitlist.ts): the patient's side.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const joinSchema = z
  .object({
    doctor: z.string(),
    // "phone" is retired (booked as sipCall / voiceCall)
    sessionType: z.enum(doctorSessionTypes).refine((t) => t !== "phone"),
    office: z.string().optional().nullable(),
    // a range of Tehran days, or "any time in the next N days"
    from: z.string().regex(YMD).optional(),
    to: z.string().regex(YMD).optional(),
    days: z.coerce.number().int().min(1).max(90).optional(),
    // (2026-10) a family member the account manages (UserRelative)
    patient: z.string().optional().nullable(),
  })
  .refine((v) => (v.from && v.to) || v.days, { message: "range" });

// «دنبال زمان زودتر هم بگرد»: an earlier slot for a booked visit
const earlierSchema = z.strictObject({ forReservation: z.string().regex(/^[0-9a-fA-F]{24}$/) });

// the identity a wait is for: none for the account's own, the member's id
// for a family member (only one this account manages)
const memberOf = async (userId: unknown, patient?: string | null) => {
  if (!patient) return { ok: true, id: null as string | null };
  if (!isValidObjectId(patient)) return { ok: false, id: null };
  const own = await UserIdentity.findOne({ user: userId }).select("_id").lean();
  if (own && String(own._id) === String(patient)) return { ok: true, id: null };
  return (await UserRelative.exists({ user: userId, other: patient })) ? { ok: true, id: String(patient) } : { ok: false, id: null };
};

// POST /user/waitlist {doctor, sessionType, office?, from+to | days}
// One active wait per (patient, doctor, visit type, office): joining again
// updates its range.
export const joinWaitlist: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (req.body && typeof req.body === "object" && "forReservation" in req.body) return joinEarlier(req, res, next);
    const parsed = joinSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isValidObjectId(parsed.data.doctor)) return next(new BadInputError());
    const input = parsed.data;
    const doctor = await DoctorProfile.findOne({
      _id: input.doctor,
      active: true,
      claimed: { $ne: false },
      status: { $ne: "suspended" },
    }).select("_id");
    if (!doctor) return next(new NotFoundError("پزشک"));
    const settings = await sessionSettingsModels[input.sessionType]
      .findOne({ doctor: doctor._id })
      .lean<{ active?: boolean; price?: number }>();
    if (!settings?.active || !settings.price)
      return next(new AppError("این پزشک قابلیت دریافت جلسه با این تایپ را ندارد", 400));
    // an office only narrows an in-person wait
    const officeId = input.sessionType === "inPerson" && input.office ? input.office : null;
    if (officeId) {
      if (
        !isValidObjectId(officeId) ||
        !(await Office.exists({ _id: officeId, doctor: doctor._id, active: { $ne: false } }))
      )
        return next(new NotFoundError("مطب"));
    }
    // the range, inside the booking horizon
    const horizon = await getBookingHorizonDays();
    const today = tehranYmd();
    const lastBookable = addDaysYmd(today, Math.max(1, horizon) - 1);
    let from = input.days ? today : (input.from as string);
    let to = input.days ? addDaysYmd(today, input.days - 1) : (input.to as string);
    if (to < from) return next(new AppError("تاریخ پایان باید بعد از تاریخ شروع باشد", 400));
    if (from < today) from = today;
    if (to > lastBookable) to = lastBookable;
    if (to < from) return next(new AppError("تاریخ پایان باید بعد از تاریخ شروع باشد", 400));

    const member = await memberOf(req.user._id, input.patient);
    if (!member.ok) return next(new NotFoundError("بیمار"));
    const officeKey = waitlistKeyFor({ office: officeId, patient: member.id });
    const existing = await WaitlistEntry.findOne({
      user: req.user._id,
      doctor: doctor._id,
      sessionType: input.sessionType,
      officeKey,
      status: "active",
    });
    if (!existing) {
      const count = await WaitlistEntry.countDocuments({ user: req.user._id, status: "active" });
      if (count >= MAX_ACTIVE_ENTRIES)
        return next(
          new AppError(`حداکثر ${MAX_ACTIVE_ENTRIES} صف انتظار فعال می‌توانید داشته باشید`, 400),
        );
    }
    // the slots free right now were on screen: only a slot that frees up
    // from here on is news
    const seen = (
      await freeSlotsFor({ doctor: doctor._id, sessionType: input.sessionType, office: officeId, from, to })
    ).map((s) => slotKey(s.ymd, s.start, s.office));
    let entry;
    if (existing) {
      existing.from = from;
      existing.to = to;
      existing.days = input.days;
      existing.seen = [...new Set([...(existing.seen || []), ...seen])].slice(-300);
      entry = await existing.save();
    } else {
      for (let i = 0; i < 3 && !entry; i++) {
        try {
          entry = await WaitlistEntry.create({
            user: req.user._id,
            doctor: doctor._id,
            sessionType: input.sessionType,
            office: officeId,
            officeKey,
            patient: member.id,
            kind: "slot",
            from,
            to,
            days: input.days,
            code: newWaitlistCode(),
            seen,
          });
        } catch (err) {
          // a code collision retries; a parallel join of the same wait wins
          if ((err as { code?: number }).code !== 11000) throw err;
          const twin = await WaitlistEntry.findOne({
            user: req.user._id,
            doctor: doctor._id,
            sessionType: input.sessionType,
            officeKey,
            status: "active",
          });
          if (twin) entry = twin;
        }
      }
      if (!entry) return next(new MiddlewareError());
    }
    res.status(200).json({
      message: "joinWaitlist",
      data: { _id: entry._id, from: entry.from, to: entry.to, status: entry.status },
    });
    queueWaitlistMatch(doctor._id);
  },
);

const activeLimitReached = async (userId: unknown) =>
  (await WaitlistEntry.countDocuments({ user: userId, status: "active" })) >= MAX_ACTIVE_ENTRIES;

// POST /user/waitlist {forReservation} - keep looking for an earlier slot
// of the same doctor and visit type (and office, in person) for a booked
// visit, until its day. Joining again is the same wait.
const joinEarlier = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = earlierSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  const r = await Reservation.findOne({ _id: parsed.data.forReservation, user: req.user._id }).lean<IReservation>();
  if (!r) return next(new NotFoundError("نوبت"));
  if (r.status !== "pending" || !(await patientCanMove(r, req.user._id)).ok)
    return next(new AppError("این نوبت دیگر قابل جابه‌جایی آنلاین نیست", 400));
  const today = tehranYmd();
  const to = tehranYmd(r.date);
  const member = await memberOf(req.user._id, String(r.patient));
  const office = r.sessionType === "inPerson" && r.office ? String(r.office) : null;
  const key = waitlistKeyFor({ office, patient: member.id, forReservation: r._id });
  const existing = await WaitlistEntry.findOne({ user: req.user._id, doctor: r.doctor, sessionType: r.sessionType, officeKey: key, status: "active" });
  if (existing) return res.status(200).json({ message: "joinWaitlist", data: { _id: existing._id, from: existing.from, to: existing.to, status: existing.status, kind: "earlier" } });
  if (await activeLimitReached(req.user._id))
    return next(new AppError(`حداکثر ${MAX_ACTIVE_ENTRIES} صف انتظار فعال می‌توانید داشته باشید`, 400));
  // the earlier slots free right now were on screen when booking
  const cutoff = tehranInstantOf(r.date, r.start).getTime();
  const seen = (await freeSlotsFor({ doctor: r.doctor, sessionType: r.sessionType, office, from: today, to }))
    .filter((sl) => fromTehranWallClock(sl.ymd, sl.start).getTime() < cutoff)
    .map((sl) => slotKey(sl.ymd, sl.start, sl.office));
  let entry;
  for (let i = 0; i < 3 && !entry; i++) {
    try {
      entry = await WaitlistEntry.create({
        user: req.user._id,
        doctor: r.doctor,
        sessionType: r.sessionType,
        office,
        officeKey: key,
        patient: member.id,
        kind: "earlier",
        forReservation: r._id,
        from: today,
        to,
        code: newWaitlistCode(),
        seen,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const twin = await WaitlistEntry.findOne({ user: req.user._id, doctor: r.doctor, sessionType: r.sessionType, officeKey: key, status: "active" });
      if (twin) entry = twin;
    }
  }
  if (!entry) return next(new MiddlewareError());
  res.status(200).json({ message: "joinWaitlist", data: { _id: entry._id, from: entry.from, to: entry.to, status: entry.status, kind: "earlier" } });
  queueWaitlistMatch(r.doctor);
};

// POST /user/waitlist/:nodeId/move - the one tap of an earlier-slot offer:
// the visit moves to the offered slot through the patient's own reschedule
// (its free-change window and slot checks), which frees the old slot for
// the next waiters
export const moveToOffer: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const entry = await WaitlistEntry.findOne({ _id: nodeId, user: req.user._id, kind: "earlier", status: "active" });
    if (!entry?.forReservation) return next(new NotFoundError());
    const o = entry.offer;
    if (!o || o.ymd < tehranYmd()) return next(new AppError("این پیشنهاد دیگر معتبر نیست", 400));
    const { moved, after } = await reschedulePatientReservation({
      userId: req.user._id,
      reservationId: entry.forReservation,
      date: o.ymd,
      start: o.start,
      end: o.end,
      office: o.office || null,
    });
    await WaitlistEntry.updateOne(
      { _id: entry._id },
      { $set: { status: "booked", reservation: entry.forReservation, endedAt: new Date(), offerOpen: false } },
    );
    res.status(200).json({ message: "moveToOffer", data: moved });
    await after();
  },
);

// GET /user/waitlist - my waits: the active ones and those that ended in
// the last 30 days
export const getMyWaitlist: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const data = await WaitlistEntry.find({
      user: req.user._id,
      $or: [{ status: "active" }, { endedAt: { $gte: since } }],
    })
      .sort({ status: 1, createdAt: -1 })
      .limit(50)
      .select("-seen")
      .populate([
        {
          path: "doctor",
          select: "firstName lastName slug avatar mainSpeciality",
          populate: { path: "mainSpeciality", select: "name" },
        },
        { path: "office", select: "name" },
        { path: "patient", select: "givenName lastName" },
        { path: "forReservation", select: "date start end status" },
      ])
      .lean();
    res.status(200).json({ message: "getMyWaitlist", data });
  },
);

// DELETE /user/waitlist/:nodeId - stop waiting
export const leaveWaitlist: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const entry = await WaitlistEntry.findOneAndUpdate(
      { _id: nodeId, user: req.user._id, status: "active" },
      { $set: { status: "cancelled", endedAt: new Date(), offerOpen: false } },
      { new: true },
    );
    if (!entry) return next(new NotFoundError());
    res.status(200).json({ message: "leaveWaitlist" });
  },
);

// GET /public/waitlist/:code - where the notice's link (/w/<code>) goes:
// the doctor's booking, on the offered slot when there is one. Shows no
// one's identity, only the doctor and the time.
export const resolveWaitlistCode: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const code = String(req.params.code || "");
    if (!/^[A-Za-z0-9_-]{6,16}$/.test(code)) return next(new NotFoundError());
    const entry = await WaitlistEntry.findOne({ code })
      .select("doctor sessionType office offer status kind forReservation patient")
      .populate({ path: "doctor", select: "slug" })
      .lean<{
        doctor?: { _id: unknown; slug?: string } | null;
        sessionType: string;
        office?: unknown;
        offer?: { ymd: string; start: number; end: number; office?: string } | null;
        status: string;
        kind?: string;
        forReservation?: unknown;
        patient?: unknown;
      }>();
    if (!entry?.doctor?._id) return next(new NotFoundError());
    const offer = entry.offer && entry.offer.ymd >= tehranYmd() ? entry.offer : null;
    res.status(200).json({
      message: "resolveWaitlistCode",
      data: {
        doctor: { _id: String(entry.doctor._id), slug: entry.doctor.slug },
        sessionType: entry.sessionType,
        office: offer?.office || (entry.office ? String(entry.office) : null),
        offer: offer ? { ymd: offer.ymd, start: offer.start, end: offer.end } : null,
        status: entry.status,
        // an earlier-slot offer opens the visit's own page (one tap to
        // move it); a family member's wait books for that member
        kind: entry.kind || "slot",
        reservation: entry.kind === "earlier" && entry.forReservation ? String(entry.forReservation) : null,
        patient: entry.patient ? String(entry.patient) : null,
      },
    });
  },
);
