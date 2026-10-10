import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError } from "../Lib/AppError";
import DoctorHolidayPolicy from "../Models/DoctorHolidayPolicy";
import Reservation from "../Models/Reservation";
import { getBookingHorizonDays } from "../Lib/appConfig";
import { addDaysYmd, fromTehranWallClock, tehranYmd } from "../Lib/tehranTime";
import {
  activeHolidays,
  holidayTitle,
  holidaysBetween,
  isClosedOn,
  policyOf,
} from "../Lib/publicHolidays";
import { refreshHolidayDays } from "../Lib/holidayRefresh";

// The doctor's official holidays (2026-10, on the hours page): the holidays
// of the booking horizon with the doctor's choice for each («تعطیلم /
// ویزیت دارم»), the global switch, and the visits already booked on each
// (they are never cancelled for a holiday; the doctor moves them).

const horizonRange = async () => {
  const today = tehranYmd();
  return { today, last: addDaysYmd(today, Math.max(1, await getBookingHorizonDays()) - 1) };
};

// GET /doctor/holidays
export const getMyHolidays: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { today, last } = await horizonRange();
    const [days, policy] = await Promise.all([holidaysBetween(today, last), policyOf(req.doctor._id)]);
    // pending visits per holiday
    const booked = new Map<string, number>();
    if (days.length) {
      const rows = await Reservation.find({
        doctor: req.doctor._id,
        status: "pending",
        $or: days.map((d) => ({
          date: { $gte: fromTehranWallClock(d.ymd, 0), $lt: fromTehranWallClock(addDaysYmd(d.ymd, 1), 0) },
        })),
      })
        .select("date")
        .lean();
      for (const r of rows) {
        const key = tehranYmd(r.date);
        booked.set(key, (booked.get(key) || 0) + 1);
      }
    }
    // the first holiday past the horizon (the empty list says when)
    const after = (await activeHolidays()).find((h) => h.ymd > last);
    res.status(200).json({
      message: "getMyHolidays",
      data: {
        works: policy.works,
        horizonEnd: last,
        holidays: days.map((d) => ({
          ymd: d.ymd,
          title: holidayTitle(d),
          closed: isClosedOn(policy, d.ymd),
          booked: booked.get(d.ymd) || 0,
        })),
        next: after ? { ymd: after.ymd, title: holidayTitle(after) } : null,
      },
    });
  },
);

const policySchema = z.strictObject({ works: z.boolean() });

// POST /doctor/holidays/policy {works} - the global switch. Days chosen one
// by one that now match the switch are dropped (nothing left to say).
export const setMyHolidayPolicy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = policySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const works = parsed.data.works;
    const current = await policyOf(req.doctor._id);
    await DoctorHolidayPolicy.updateOne(
      { doctor: req.doctor._id },
      {
        $set: {
          works,
          // under "works", an open day is the default; under "closed", a closed one
          open: works ? [] : current.open,
          closed: works ? current.closed : [],
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.status(200).json({ message: "setMyHolidayPolicy" });
    const { today, last } = await horizonRange();
    const days = (await holidaysBetween(today, last)).map((d) => d.ymd);
    refreshHolidayDays(days, [req.doctor._id]).catch(() => undefined);
  },
);

const daySchema = z.strictObject({
  ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // true: «ویزیت دارم» (takes visits), false: «تعطیلم»
  open: z.boolean(),
});

// POST /doctor/holidays/day {ymd, open} - the choice for one holiday
export const setMyHolidayDay: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = daySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { ymd, open } = parsed.data;
    if (ymd < tehranYmd()) return next(new BadInputError("امکان ثبت در روز گذشته وجود ندارد"));
    if (!(await holidaysBetween(ymd, ymd)).length)
      return next(new AppError("این روز تعطیل رسمی نیست", 400));
    const policy = await policyOf(req.doctor._id);
    const openList = policy.open.filter((d) => d !== ymd);
    const closedList = policy.closed.filter((d) => d !== ymd);
    // only a choice against the switch is kept
    if (open && !policy.works) openList.push(ymd);
    if (!open && policy.works) closedList.push(ymd);
    await DoctorHolidayPolicy.updateOne(
      { doctor: req.doctor._id },
      { $set: { works: policy.works, open: openList.sort(), closed: closedList.sort(), updatedAt: new Date() } },
      { upsert: true },
    );
    res.status(200).json({ message: "setMyHolidayDay" });
    refreshHolidayDays([ymd], [req.doctor._id]).catch(() => undefined);
  },
);
