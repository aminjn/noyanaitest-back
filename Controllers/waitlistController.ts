import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { doctorSessionTypes } from "../Models/DoctorSession";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import WaitlistEntry from "../Models/WaitlistEntry";
import { getBookingHorizonDays } from "../Lib/appConfig";
import { sessionSettingsModels } from "../Lib/bookingFlow";
import { addDaysYmd, tehranYmd } from "../Lib/tehranTime";
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
  })
  .refine((v) => (v.from && v.to) || v.days, { message: "range" });

// POST /user/waitlist {doctor, sessionType, office?, from+to | days}
// One active wait per (patient, doctor, visit type, office): joining again
// updates its range.
export const joinWaitlist: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
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

    const officeKey = officeId ? String(officeId) : "";
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
      .select("doctor sessionType office offer status")
      .populate({ path: "doctor", select: "slug" })
      .lean<{
        doctor?: { _id: unknown; slug?: string } | null;
        sessionType: string;
        office?: unknown;
        offer?: { ymd: string; start: number; end: number; office?: string } | null;
        status: string;
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
      },
    });
  },
);
