import DoctorAvailability from "../Models/DoctorAvailability";
import DoctorProfile, { IDoctorProfile } from "../Models/DoctorProfile";
import DoctorShift from "../Models/DoctorShift";
import DoctorTimeOff from "../Models/DoctorTimeOff";
import Reservation from "../Models/Reservation";
import { addDaysYmd, fromTehranWallClock, tehranSaturdayDay, tehranYmd } from "./tehranTime";
import { getShiftSessionBounds } from "./shiftUtils";
import { blockedFrom, overlapsBlocked } from "./timeOff";

// the Tehran day of a stored day key (either convention, Lib/tehranTime.ts)
const generateReservationDateKey = (d: Date) => tehranYmd(d);

const updateDoctorAvailability = async ({
  doctor: d,
  endDate,
  startDate,
}: {
  doctor: IDoctorProfile;
  startDate: Date;
  endDate: Date;
}) => {
  try {
    //TODO: this whole shit needs to be in a transaction
    const doctor = await DoctorProfile.findOne({ _id: d._id });
    if (!doctor) throw new Error("Doctor Does Not Exist");
    // whole Tehran days, [first midnight, the midnight after the last)
    const firstYmd = tehranYmd(startDate);
    const lastYmd = tehranYmd(endDate);
    const current = fromTehranWallClock(firstYmd, 0);
    const end = fromTehranWallClock(addDaysYmd(lastYmd, 1), 0);
    await DoctorAvailability.deleteMany({
      doctor: doctor._id,
      date: { $lt: end, $gte: current },
    });
    const shifts = await DoctorShift.find({ doctor: doctor._id });
    const shiftsByDay = new Map<number, typeof shifts>();
    for (const shift of shifts) {
      const existing = shiftsByDay.get(shift.day) ?? [];
      existing.push(shift);
      existing.sort((a, b) => a.start - b.start);
      shiftsByDay.set(shift.day, existing);
    }
    const reservations = await Reservation.find({
      doctor: doctor._id,
      status: { $ne: "cancelled" },
      date: { $lt: end, $gte: current },
    });
    const reservationsByDate = new Map<string, typeof reservations>();
    for (const reservation of reservations) {
      const key = generateReservationDateKey(reservation.date);
      const existing = reservationsByDate.get(key) ?? [];
      existing.push(reservation);
      reservationsByDate.set(key, existing);
    }
    // days off: no slot at all on them; blocked hours: none in them
    const timeOff = await DoctorTimeOff.find({
      doctor: doctor._id,
      from: { $lt: end },
      to: { $gte: current },
    }).lean();
    const availabilityDocuments = [];
    for (let ymd = firstYmd; ymd <= lastYmd; ymd = addDaysYmd(ymd, 1)) {
      const day = fromTehranWallClock(ymd, 0);
      const todayIndex = tehranSaturdayDay(day);
      const blocked = blockedFrom(timeOff, day);
      const todayShifts = blocked.wholeDay ? [] : (shiftsByDay.get(todayIndex) ?? []);
      if (!!todayShifts.length) {
        const bounds = todayShifts.reduce(
          (acc, shift) => [...acc, ...getShiftSessionBounds(shift)],
          [] as [number, number][],
        );
        const reservedForToday =
          reservationsByDate.get(ymd) ?? [];
        const availableBounds = bounds.filter(
          ([start, end]) =>
            !overlapsBlocked(blocked.ranges, start, end) &&
            !reservedForToday.some(
              (reservation) =>
                !(reservation.end <= start || reservation.start >= end),
            ),
        );
        if (!!availableBounds.length)
          availabilityDocuments.push({
            doctor: doctor._id,
            date: day,
            isAvailable: true,
            bounds: availableBounds.map(([start, end]) => ({ start, end })),
            start: availableBounds[0][0],
            end: availableBounds[availableBounds.length - 1][1],
          });
      }
    }
    if (!!availabilityDocuments.length)
      await DoctorAvailability.insertMany(availabilityDocuments);
  } catch (err) {
    console.log("Failed To Update Dcotor Availability Reason: ", err);
  }
};

export default updateDoctorAvailability;
