import DoctorTimeOff from "../Models/DoctorTimeOff";
import { tehranDayRange, tehranYmd } from "./tehranTime";
import { holidayClosures } from "./publicHolidays";

// Time off (2026-10): whole days (leave, holidays) or, with startMin/endMin,
// the same hours blocked on each day of the range (a meeting, surgery, a
// long lunch). Minutes are Tehran wall-clock, like shift minutes.

export type BlockedRange = [number, number];

// `holiday`: an official holiday the doctor is closed on (its title), from
// Lib/publicHolidays.ts - a whole day, like a day off
type TimeOffLike = { from: Date; to: Date; startMin?: number | null; endMin?: number | null; holiday?: string };

export const isPartial = (t: TimeOffLike) =>
  typeof t.startMin === "number" && typeof t.endMin === "number" && t.endMin > t.startMin;

// from / to are day keys (the midnight of their days); compared as Tehran
// calendar days, so keys saved at UTC or Tehran midnight both work
// (Lib/tehranTime.ts)
const covers = (t: TimeOffLike, ymd: string) => tehranYmd(t.from) <= ymd && ymd <= tehranYmd(t.to);

// a Mongo filter for the time off touching the Tehran day of `day`
export const touchingDay = (day: Date) => {
  const { start, end } = tehranDayRange(day);
  return { from: { $lt: end }, to: { $gte: start } };
};

// what the given time off blocks on the Tehran day of `day`
export const blockedFrom = (records: TimeOffLike[], day: Date) => {
  const ymd = tehranYmd(day);
  const covering = records.filter((t) => covers(t, ymd));
  const wholeDay = covering.some((t) => !isPartial(t));
  const ranges: BlockedRange[] = covering
    .filter(isPartial)
    .map((t) => [t.startMin as number, t.endMin as number]);
  const holiday = covering.find((t) => !!t.holiday)?.holiday || null;
  return { wholeDay, ranges, holiday };
};

export const overlapsBlocked = (ranges: BlockedRange[], start: number, end: number) =>
  ranges.some(([a, b]) => !(end <= a || start >= b));

// The time off of one doctor or several touching [from, to) - their own
// days off and blocked hours, plus the official holidays each is closed on
// (Lib/publicHolidays.ts). The one loader every free-slot reader uses, so
// a closed holiday is a day off everywhere.
export const loadTimeOff = async (doctor: unknown, from: Date, to: Date) => {
  const ids = Array.isArray(doctor) ? doctor : [doctor];
  const lastYmd = tehranYmd(new Date(to.getTime() - 1));
  const [records, closures] = await Promise.all([
    DoctorTimeOff.find({ doctor: Array.isArray(doctor) ? { $in: ids } : doctor, from: { $lt: to }, to: { $gte: from } })
      .select("doctor from to startMin endMin")
      .lean(),
    holidayClosures(ids, tehranYmd(from), lastYmd).catch(() => []),
  ]);
  return [...records, ...closures] as (TimeOffLike & { doctor?: unknown })[];
};

// the doctor's time off touching `day` (closed holidays included)
export const blockedOn = async (doctor: unknown, day: Date) => {
  const { start, end } = tehranDayRange(day);
  return blockedFrom(await loadTimeOff(doctor, start, end), day);
};

// a Mongo filter for whole-day time off only
export const wholeDayOnly = {
  $or: [{ startMin: { $exists: false } }, { startMin: null }],
};
