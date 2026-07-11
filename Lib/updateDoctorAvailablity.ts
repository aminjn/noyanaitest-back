import DoctorAvailability from "../Models/DoctorAvailability";
import DoctorProfile, { IDoctorProfile } from "../Models/DoctorProfile";
import DoctorShift from "../Models/DoctorShift";
import Reservation from "../Models/Reservation";
import { saturdayBasedDay } from "./dateUtils";
import { getShiftSessionBounds } from "./shiftUtils";

const generateReservationDateKey = (d: Date) => new Date(d).toDateString();

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
    const current = new Date(startDate);
    current.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    await DoctorAvailability.deleteMany({
      doctor: doctor._id,
      date: { $lte: end, $gte: current },
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
      date: { $lte: end, $gte: current },
    });
    const reservationsByDate = new Map<string, typeof reservations>();
    for (const reservation of reservations) {
      const key = generateReservationDateKey(reservation.date);
      const existing = reservationsByDate.get(key) ?? [];
      existing.push(reservation);
      reservationsByDate.set(key, existing);
    }
    const availabilityDocuments = [];
    while (current <= end) {
      const todayIndex = saturdayBasedDay(current.getDay());
      const todayShifts = shiftsByDay.get(todayIndex) ?? [];
      if (!!todayShifts.length) {
        const bounds = todayShifts.reduce(
          (acc, shift) => [...acc, ...getShiftSessionBounds(shift)],
          [] as [number, number][],
        );
        const reservedForToday =
          reservationsByDate.get(generateReservationDateKey(current)) ?? [];
        const availableBounds = bounds.filter(
          ([start, end]) =>
            !reservedForToday.some(
              (reservation) =>
                !(reservation.end <= start || reservation.start >= end),
            ),
        );
        if (!!availableBounds.length)
          availabilityDocuments.push({
            doctor: doctor._id,
            date: new Date(current),
            isAvailable: true,
            bounds: availableBounds.map(([start, end]) => ({ start, end })),
            start: availableBounds[0][0],
            end: availableBounds[availableBounds.length - 1][1],
          });
      }
      current.setDate(current.getDate() + 1);
    }
    if (!!availabilityDocuments.length)
      await DoctorAvailability.insertMany(availabilityDocuments);
  } catch (err) {
    console.log("Failed To Update Dcotor Availability Reason: ", err);
  }
};

export default updateDoctorAvailability;
