import mongoose from "mongoose";
import DoctorInsurance from "../Models/DoctorInsurance";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";

export type InsuranceNetwork = {
  doctors: number;
  clinics: number;
  hospitals: number;
  paraClinics: number;
};

type Id = mongoose.Types.ObjectId | string;

const countBy = (rows: { _id: unknown; count: number }[]) =>
  new Map(rows.map((el) => [String(el._id), el.count]));

// Like Zocdoc's "in network" and Paziresh24's insurance filter (2026-09): an
// insurer's network is who actually accepts it on the site - the doctors that
// added it in their panel and the centres that list it - counted live, not
// typed in by hand (the old doctorsCount / centersCount fields drifted).
export const getInsuranceNetworks = async (ids: Id[]) => {
  const objectIds = ids.map((el) => new mongoose.Types.ObjectId(String(el)));
  const byArray = (isActiveField: string) => [
    { $match: { [isActiveField]: true, insurances: { $in: objectIds } } },
    { $unwind: "$insurances" },
    { $match: { insurances: { $in: objectIds } } },
    { $group: { _id: "$insurances", count: { $sum: 1 } } },
  ];
  const [doctors, clinics, hospitals, paraClinics] = await Promise.all([
    DoctorInsurance.aggregate([
      { $match: { insurance: { $in: objectIds } } },
      {
        $lookup: {
          from: "doctorprofiles",
          localField: "doctor",
          foreignField: "_id",
          as: "doctor",
          pipeline: [{ $match: { active: true } }, { $project: { _id: 1 } }],
        },
      },
      { $match: { "doctor.0": { $exists: true } } },
      { $group: { _id: "$insurance", count: { $sum: 1 } } },
    ]),
    Clinic.aggregate(byArray("active")),
    Hospital.aggregate(byArray("isActive")),
    ParaClinic.aggregate(byArray("active")),
  ]);
  const maps = {
    doctors: countBy(doctors),
    clinics: countBy(clinics),
    hospitals: countBy(hospitals),
    paraClinics: countBy(paraClinics),
  };
  return new Map<string, InsuranceNetwork>(
    objectIds.map((id) => {
      const key = String(id);
      return [
        key,
        {
          doctors: maps.doctors.get(key) || 0,
          clinics: maps.clinics.get(key) || 0,
          hospitals: maps.hospitals.get(key) || 0,
          paraClinics: maps.paraClinics.get(key) || 0,
        },
      ];
    }),
  );
};
