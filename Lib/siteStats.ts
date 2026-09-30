import DoctorProfile from "../Models/DoctorProfile";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Reservation from "../Models/Reservation";
import User from "../Models/User";
import Insurance from "../Models/Insurance";
import DoctorInsurance from "../Models/DoctorInsurance";

export type SiteStats = {
  doctors: number;
  pharmacies: number;
  labs: number;
  // clinics + hospitals
  centers: number;
  // people who booked at least one visit that wasn't cancelled
  patients: number;
  users: number;
  consultations: number;
  // share of reviews that recommend the doctor; null until there are enough
  // reviews for the number to mean something
  satisfactionPercent: number | null;
  feedbackCount: number;
  insurers: number;
  insuranceCenters: number;
  insuranceDoctors: number;
};

// a percentage from a handful of reviews is noise, not a claim
const MIN_FEEDBACKS_FOR_SATISFACTION = 20;
const TTL = 10 * 60 * 1000;
let cache: { at: number; value: SiteStats } | null = null;

// Every public number on the home, about and insurance pages (2026-09) comes
// from here - counted from the site's own data, never typed in. Cached for
// ten minutes: the pages are public and the counts move slowly.
export const getSiteStats = async (): Promise<SiteStats> => {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const [
    doctors,
    pharmacies,
    labs,
    clinics,
    hospitals,
    patients,
    users,
    consultations,
    feedback,
    insurers,
    insuredClinics,
    insuredHospitals,
    insuredLabs,
    insuranceDoctorIds,
  ] = await Promise.all([
    DoctorProfile.countDocuments({ active: true }),
    Pharmacy.countDocuments({ active: true }),
    ParaClinic.countDocuments({ active: true }),
    Clinic.countDocuments({ active: true }),
    Hospital.countDocuments({ isActive: true }),
    Reservation.distinct("patient", {
      status: { $in: ["pending", "active", "completed"] },
    }).then((el) => el.length),
    User.countDocuments({ role: "user" }),
    Reservation.countDocuments({ status: "completed" }),
    DoctorProfile.aggregate<{ feedbacks: number; recommends: number }>([
      { $match: { active: true } },
      {
        $group: {
          _id: null,
          feedbacks: { $sum: "$feedbackCount" },
          recommends: { $sum: "$recommendCount" },
        },
      },
    ]).then((el) => el[0] || { feedbacks: 0, recommends: 0 }),
    Insurance.countDocuments({ active: true }),
    Clinic.countDocuments({ active: true, "insurances.0": { $exists: true } }),
    Hospital.countDocuments({
      isActive: true,
      "insurances.0": { $exists: true },
    }),
    ParaClinic.countDocuments({
      active: true,
      "insurances.0": { $exists: true },
    }),
    DoctorInsurance.distinct("doctor"),
  ]);
  const insuranceDoctors = await DoctorProfile.countDocuments({
    _id: { $in: insuranceDoctorIds },
    active: true,
  });
  const value: SiteStats = {
    doctors,
    pharmacies,
    labs,
    centers: clinics + hospitals,
    patients,
    users,
    consultations,
    feedbackCount: feedback.feedbacks,
    satisfactionPercent:
      feedback.feedbacks >= MIN_FEEDBACKS_FOR_SATISFACTION
        ? Math.round((feedback.recommends / feedback.feedbacks) * 100)
        : null,
    insurers,
    insuranceCenters: insuredClinics + insuredHospitals + insuredLabs,
    insuranceDoctors,
  };
  cache = { at: Date.now(), value };
  return value;
};
