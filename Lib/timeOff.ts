import DoctorTimeOff from "../Models/DoctorTimeOff";
import { tehranDayRange, tehranYmd } from "./tehranTime";

// Time off (2026-10): whole days (leave, holidays) or, with startMin/endMin,
// the same hours blocked on each day of the range (a meeting, surgery, a
// long lunch). Minutes are Tehran wall-clock, like shift minutes.

export type BlockedRange = [number, number];

type TimeOffLike = { from: Date; to: Date; startMin?: number | null; endMin?: number | null };

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
  return { wholeDay, ranges };
};

export const overlapsBlocked = (ranges: BlockedRange[], start: number, end: number) =>
  ranges.some(([a, b]) => !(end <= a || start >= b));

// the doctor's time off touching `day`
export const blockedOn = async (doctor: unknown, day: Date) => {
  const records = await DoctorTimeOff.find({ doctor, ...touchingDay(day) })
    .select("from to startMin endMin")
    .lean();
  return blockedFrom(records, day);
};

// a Mongo filter for whole-day time off only
export const wholeDayOnly = {
  $or: [{ startMin: { $exists: false } }, { startMin: null }],
};
