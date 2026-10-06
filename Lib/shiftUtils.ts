import { IDoctorShift } from "../Models/DoctorShift";

export const getShiftSessionBounds = (
  shift: IDoctorShift,
): [number, number][] => {
  const result: [number, number][] = [];
  // a zero-length visit would never advance the cursor (an endless loop
  // that froze the API); a visit must also end inside the shift
  const duration = Number(shift.duration) || 0;
  const step = duration + Math.max(0, Number(shift.gap) || 0);
  if (duration <= 0 || shift.start >= shift.end) return [];
  for (let now = shift.start; now + duration <= shift.end; now += step) {
    result.push([now, now + duration]);
  }
  return result;
};
