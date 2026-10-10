import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError } from "../Lib/AppError";
import DoctorShift from "../Models/DoctorShift";
import DoctorTimeOff from "../Models/DoctorTimeOff";
import Office from "../Models/Office";
import Reservation from "../Models/Reservation";
import { bookableDays } from "../Lib/bookingFlow";
import { blockedFrom, isPartial, loadTimeOff, overlapsBlocked } from "../Lib/timeOff";
import { holidaysBetween, holidayTitle, isClosedOn, policyOf } from "../Lib/publicHolidays";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import { addDaysYmd, diffDaysYmd, fromTehranWallClock, tehranSaturdayDay, tehranYmd } from "../Lib/tehranTime";
import { aclAllows } from "./aclController";

// The hours page's month calendar (2026-10, «ساعات کاری»): one call gives
// every day of a range at a glance - is it a working day in the weekly
// template, how many visits it makes, how many are booked and still free,
// the official holiday on it (closed or open) and the doctor's time off -
// and, for whoever may read the agenda, the day's visits for the day panel.
// Doctolib Pro's agenda shows opening hours, absences and holidays on one
// calendar; this is its data. It reuses the booking rules, never a copy:
// free slots come from Lib/bookingFlow.ts `bookableDays`, blocked days and
// hours from Lib/timeOff.ts `loadTimeOff` (closed holidays included), the
// holidays and the doctor's choice from Lib/publicHolidays.ts.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
// a month grid of any calendar fits (Persian months are 29-31 days)
const MAX_RANGE_DAYS = 62;
// the agenda keeps three months back; the holidays reach a year ahead
const MAX_BACK_DAYS = 120;
const MAX_AHEAD_DAYS = 400;

const querySchema = z.object({
  from: z.string().regex(YMD).optional(),
  to: z.string().regex(YMD).optional(),
});

type DayVisit = {
  _id: string;
  start: number;
  end: number;
  sessionType: string;
  status: string;
  patient: string;
  office: string | null;
};

type DaySummary = {
  ymd: string;
  // 0 = Saturday ... 6 = Friday (the shift weekdays)
  weekday: number;
  // the weekly template has hours that weekday (at an active office)
  working: boolean;
  // the visits the day makes once time off and a closed holiday are taken out
  slots: number;
  // visits booked that day (a cancelled one is not counted)
  booked: number;
  // slots a patient can still book (bookableDays); null outside today..horizon
  free: number | null;
  holiday?: { title: string; closed: boolean; estimated?: boolean };
  timeOff?: { _id: string; from: string; to: string; note?: string; startMin?: number; endMin?: number }[];
  visits?: DayVisit[];
};

// GET /doctor/hours/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
export const getHoursSummary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const today = tehranYmd();
    const fromYmd = parsed.data.from || today;
    const toYmd = parsed.data.to || addDaysYmd(fromYmd, 41);
    const span = diffDaysYmd(fromYmd, toYmd);
    if (!(span >= 0) || span >= MAX_RANGE_DAYS) return next(new AppError("بازه‌ی تاریخ معتبر نیست", 400));
    if (diffDaysYmd(fromYmd, today) > MAX_BACK_DAYS || diffDaysYmd(today, toYmd) > MAX_AHEAD_DAYS)
      return next(new AppError("بازه‌ی تاریخ معتبر نیست", 400));

    const doctorId = req.doctor._id;
    const withVisits = aclAllows(req, "readSchedule");
    const from = fromTehranWallClock(fromYmd, 0);
    const to = fromTehranWallClock(addDaysYmd(toYmd, 1), 0);
    // free slots exist only from today on; skip the work for a past range
    const wantsFree = toYmd >= today;

    const [shifts, reservations, timeOff, holidays, policy, bookable] = await Promise.all([
      DoctorShift.find({ doctor: doctorId }).select("day start end duration gap office").lean(),
      Reservation.find({ doctor: doctorId, status: { $ne: "cancelled" }, date: { $gte: from, $lt: to } })
        .select(withVisits ? "date start end sessionType status patient office" : "date")
        .populate(withVisits ? [{ path: "patient", select: "givenName lastName" }] : [])
        .lean(),
      loadTimeOff(doctorId, from, to),
      holidaysBetween(fromYmd, toYmd),
      policyOf(doctorId),
      wantsFree ? bookableDays({ doctorId }).catch(() => null) : Promise.resolve(null),
    ]);

    // only offices that still exist and are active take bookings (the rule
    // bookableDays applies), so only their hours make a working day
    const officeIds = [...new Set(shifts.map((s) => String(s.office)).filter(Boolean))];
    const activeOffices = new Set(
      (await Office.find({ _id: { $in: officeIds }, active: { $ne: false } }).select("_id").lean()).map((o) =>
        String(o._id),
      ),
    );
    const liveShifts = shifts.filter((s) => activeOffices.has(String(s.office)));

    // the doctor's own time off (closed holidays come as `holiday` rows)
    const records = timeOff as ((typeof timeOff)[number] & { _id?: unknown })[];
    const ownIds = records.filter((t) => !t.holiday && t._id).map((t) => t._id);
    const notes = new Map(
      ownIds.length
        ? (await DoctorTimeOff.find({ _id: { $in: ownIds } }).select("note").lean()).map((t) => [
            String(t._id),
            t.note || "",
          ])
        : [],
    );

    const bookedByDay = new Map<string, number>();
    const visitsByDay = new Map<string, DayVisit[]>();
    for (const r of Array.isArray(reservations) ? reservations : []) {
      if (!r || !r.date) continue;
      const key = tehranYmd(r.date);
      bookedByDay.set(key, (bookedByDay.get(key) || 0) + 1);
      if (!withVisits) continue;
      const p = (r.patient || {}) as { givenName?: string; lastName?: string };
      const list = visitsByDay.get(key) ?? [];
      list.push({
        _id: String(r._id),
        start: Number(r.start) || 0,
        end: Number(r.end) || 0,
        sessionType: String(r.sessionType || ""),
        status: String(r.status || ""),
        patient: [p.givenName, p.lastName].filter(Boolean).join(" "),
        office: r.office ? String(r.office) : null,
      });
      visitsByDay.set(key, list);
    }

    const freeByDay = new Map<string, number>();
    for (const d of bookable?.days ?? []) freeByDay.set(d.ymd, d.bounds.length);
    const horizonEnd = bookable ? addDaysYmd(today, bookable.horizon - 1) : null;

    const holidayByDay = new Map(holidays.map((h) => [h.ymd, h]));

    const days: DaySummary[] = [];
    for (let ymd = fromYmd; ymd <= toYmd; ymd = addDaysYmd(ymd, 1)) {
      const day = fromTehranWallClock(ymd, 0);
      const weekday = tehranSaturdayDay(day);
      const blocked = blockedFrom(timeOff, day);
      const ofDay = liveShifts.filter((s) => s.day === weekday);
      // the visits the template makes that day, as bookableDays counts them
      // (one per distinct time, none in a blocked hour)
      const seen = new Set<string>();
      if (!blocked.wholeDay)
        for (const shift of ofDay)
          for (const [start, end] of getShiftSessionBounds(shift as never)) {
            if (overlapsBlocked(blocked.ranges, start, end)) continue;
            seen.add(`${start}-${end}`);
          }
      const out: DaySummary = {
        ymd,
        weekday,
        working: ofDay.length > 0,
        slots: seen.size,
        booked: bookedByDay.get(ymd) || 0,
        free: horizonEnd && ymd >= today && ymd <= horizonEnd ? freeByDay.get(ymd) || 0 : null,
      };
      const h = holidayByDay.get(ymd);
      if (h)
        out.holiday = {
          title: holidayTitle(h),
          closed: isClosedOn(policy, ymd),
          // set once the holiday list says a date is not yet fixed (a lunar date)
          ...((h as { estimated?: unknown }).estimated === true ? { estimated: true } : {}),
        };
      const own = records.filter((t) => !t.holiday && !!t._id && tehranYmd(t.from) <= ymd && ymd <= tehranYmd(t.to));
      if (own.length)
        out.timeOff = own.map((t) => ({
          _id: String(t._id),
          from: tehranYmd(t.from),
          to: tehranYmd(t.to),
          ...(notes.get(String(t._id)) ? { note: notes.get(String(t._id)) } : {}),
          ...(isPartial(t) ? { startMin: t.startMin as number, endMin: t.endMin as number } : {}),
        }));
      if (withVisits) {
        const list = visitsByDay.get(ymd);
        out.visits = list ? list.sort((a, b) => a.start - b.start) : [];
      }
      days.push(out);
    }

    res.status(200).json({
      message: "getHoursSummary",
      data: {
        from: fromYmd,
        to: toYmd,
        today,
        horizonEnd,
        // the holiday switch («روزهای تعطیل رسمی کار می‌کنم»)
        works: policy.works,
        visits: withVisits,
        days,
      },
    });
  },
);
