import DoctorShift from "../Models/DoctorShift";
import updateDoctorAvailability from "./updateDoctorAvailablity";
import { getBookingHorizonDays } from "./appConfig";
import { addDaysYmd, fromTehranWallClock, tehranYmd } from "./tehranTime";

// After an official holiday or a doctor's choice for one changes
// (Lib/publicHolidays.ts): the availability cache (DoctorAvailability, the
// search's «earliest» order) of those days is rebuilt, in the background,
// for the doctors given or every doctor with hours. Days outside the
// booking horizon have no cache to fix.
export const refreshHolidayDays = async (ymds: string[], doctorIds?: unknown[]) => {
  const today = tehranYmd();
  const last = addDaysYmd(today, await getBookingHorizonDays());
  const days = [...new Set(ymds)].filter((y) => typeof y === "string" && y >= today && y <= last).sort();
  if (!days.length) return;
  const doctors = doctorIds?.length ? doctorIds : await DoctorShift.distinct("doctor");
  for (const id of doctors) {
    // whole runs of days at once (a doctor's global switch covers many)
    await updateDoctorAvailability({
      doctor: { _id: id } as never,
      startDate: fromTehranWallClock(days[0], 0),
      endDate: fromTehranWallClock(days[days.length - 1], 0),
    }).catch(() => undefined);
  }
};
