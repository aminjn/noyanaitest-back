import DoctorTimeOff from "../Models/DoctorTimeOff";

// Time off (2026-10): whole days (leave, holidays) or, with startMin/endMin,
// the same hours blocked on each day of the range (a meeting, surgery, a
// long lunch). Minutes are Tehran wall-clock, like shift minutes.

export type BlockedRange = [number, number];

type TimeOffLike = { from: Date; to: Date; startMin?: number | null; endMin?: number | null };

export const isPartial = (t: TimeOffLike) =>
  typeof t.startMin === "number" && typeof t.endMin === "number" && t.endMin > t.startMin;

// what the given time off blocks on `day` (local midnight)
export const blockedFrom = (records: TimeOffLike[], day: Date) => {
  const covering = records.filter((t) => new Date(t.from) <= day && day <= new Date(t.to));
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
  const records = await DoctorTimeOff.find({ doctor, from: { $lte: day }, to: { $gte: day } })
    .select("from to startMin endMin")
    .lean();
  return blockedFrom(records, day);
};

// a Mongo filter for whole-day time off only
export const wholeDayOnly = {
  $or: [{ startMin: { $exists: false } }, { startMin: null }],
};
