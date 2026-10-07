import mongoose from "mongoose";
import DoctorInsurance from "../Models/DoctorInsurance";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Office from "../Models/Office";
import DoctorProfile from "../Models/DoctorProfile";

export type InsuranceNetwork = {
  doctors: number;
  clinics: number;
  hospitals: number;
  paraClinics: number;
};

type Id = mongoose.Types.ObjectId | string;

const countBy = (rows: { _id: unknown; count: number }[]) =>
  new Map(rows.map((el) => [String(el._id), el.count]));

// The doctors who accept each insurer, by the same rule the booking quote
// applies (Lib/insuranceTariffs.ts acceptedInsurances): the doctor's own
// list (doctor panel → insurances) or, for an in-person visit, the clinic or
// hospital their office is in. Before (2026-10) the /book filter and the
// network counts read only the doctor's own list, so a doctor whose clinic
// holds the Tamin contract was priced with Tamin at booking but never found
// by "who takes Tamin". Active doctors, active offices and active centres
// only (a switched-off centre lends no contract, as in the quote).
// `centres: false`: the doctor's own list only (online visits: a centre's
// insurers apply to an in-person visit at its office).
export const doctorsAcceptingInsurances = async (ids: Id[], { centres = true }: { centres?: boolean } = {}) => {
  const objectIds = ids.filter((el) => mongoose.isValidObjectId(String(el))).map((el) => new mongoose.Types.ObjectId(String(el)));
  const out = new Map<string, Set<string>>(objectIds.map((id) => [String(id), new Set<string>()]));
  if (!objectIds.length) return out;
  const [own, clinics, hospitals] = await Promise.all([
    DoctorInsurance.find({ insurance: { $in: objectIds } }).select("doctor insurance").lean<{ doctor?: unknown; insurance?: unknown }[]>(),
    centres ? Clinic.find({ insurances: { $in: objectIds }, active: true }).select("insurances").lean<{ _id: unknown; insurances?: unknown[] }[]>() : [],
    centres ? Hospital.find({ insurances: { $in: objectIds }, isActive: true }).select("insurances").lean<{ _id: unknown; insurances?: unknown[] }[]>() : [],
  ]);
  const offices =
    clinics.length || hospitals.length
      ? await Office.find({
          active: true,
          $or: [
            ...(clinics.length ? [{ clinic: { $in: clinics.map((c) => c._id) } }] : []),
            ...(hospitals.length ? [{ hospital: { $in: hospitals.map((h) => h._id) } }] : []),
          ],
        })
          .select("doctor clinic hospital")
          .lean<{ doctor?: unknown; clinic?: unknown; hospital?: unknown }[]>()
      : [];
  const centreInsurances = new Map<string, string[]>();
  for (const c of [...clinics, ...hospitals])
    centreInsurances.set(String(c._id), (Array.isArray(c.insurances) ? c.insurances : []).map((i) => String(i)));
  const pairs: [string, string][] = [];
  for (const r of own) if (r.doctor && r.insurance) pairs.push([String(r.insurance), String(r.doctor)]);
  for (const o of offices) {
    if (!o.doctor) continue;
    for (const i of centreInsurances.get(String(o.clinic || o.hospital || "")) || []) pairs.push([i, String(o.doctor)]);
  }
  const doctorIds = [...new Set(pairs.map(([, d]) => d))];
  const active = new Set(
    doctorIds.length
      ? (await DoctorProfile.find({ _id: { $in: doctorIds }, active: true }).select("_id").lean<{ _id: unknown }[]>()).map((d) => String(d._id))
      : [],
  );
  for (const [i, d] of pairs) if (active.has(d)) out.get(i)?.add(d);
  return out;
};

// every doctor who accepts any of these insurers (the /book filter)
export const doctorIdsAccepting = async (ids: Id[], opts?: { centres?: boolean }) => {
  const map = await doctorsAcceptingInsurances(ids, opts);
  const all = new Set<string>();
  for (const set of map.values()) for (const d of set) all.add(d);
  return [...all].map((d) => new mongoose.Types.ObjectId(d));
};

// Like Zocdoc's "in network" and Paziresh24's insurance filter (2026-09): an
// insurer's network is who actually accepts it on the site - the doctors who
// take it (their own list, or the centre of their office: the booking's
// rule, doctorsAcceptingInsurances above) and the centres that list it -
// counted live, not typed in by hand (the old doctorsCount / centersCount
// fields drifted).
export const getInsuranceNetworks = async (ids: Id[]) => {
  const objectIds = ids.map((el) => new mongoose.Types.ObjectId(String(el)));
  const byArray = (isActiveField: string) => [
    { $match: { [isActiveField]: true, insurances: { $in: objectIds } } },
    { $unwind: "$insurances" },
    { $match: { insurances: { $in: objectIds } } },
    { $group: { _id: "$insurances", count: { $sum: 1 } } },
  ];
  const [doctors, clinics, hospitals, paraClinics] = await Promise.all([
    doctorsAcceptingInsurances(objectIds),
    Clinic.aggregate(byArray("active")),
    Hospital.aggregate(byArray("isActive")),
    ParaClinic.aggregate(byArray("active")),
  ]);
  const maps = {
    doctors: new Map([...doctors.entries()].map(([k, v]) => [k, v.size])),
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
