import { IDoctorShift } from "../Models/DoctorShift";

export const getShiftSessionBounds = (
  shift: IDoctorShift,
): [number, number][] => {
  const result: [number, number][] = [];
  if (shift.start >= shift.end) return [];
  let now = shift.start;
  result.push([now, now + shift.duration]);
  now += shift.duration + shift.gap;
  while (now <= shift.end - shift.duration) {
    result.push([now, now + shift.duration]);
    now += shift.duration + shift.gap;
  }
  return result;
};
