import { addTehranDays, fromTehranWallClock, startOfTehranDay, tehranDaysBetween, tehranSaturdayDay } from "./tehranTime";

// Day keys (Reservation.date, DoctorAvailability.date, ...) are the Tehran
// midnight of the day, whatever the server's zone (Lib/tehranTime.ts).
export const dateStartOfDay = (t: Date | string | number) => startOfTehranDay(t);

export const todayStart = () => startOfTehranDay();

// the next Tehran midnight: the end (exclusive) of today's range
export const tomorrowStart = () => addTehranDays(new Date(), 1);

export const saturdayBasedDay = (day: number) => (day + 1) % 7;

// the shift day index (0 = Saturday) of the Tehran day an instant falls in
export const saturdayBasedDayOf = (t: Date | string | number) => tehranSaturdayDay(t);

// the shift day indices (0 = Saturday) the Tehran days of [start, end] cover
export function getDaysInRange(start: Date, end: Date): number[] {
  const days = tehranDaysBetween(start, end, 8);
  if (days.length >= 7) return [0, 1, 2, 3, 4, 5, 6];
  return [...new Set(days.map((ymd) => tehranSaturdayDay(fromTehranWallClock(ymd, 12 * 60))))];
}
