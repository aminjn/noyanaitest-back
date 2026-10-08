import mongoose from "mongoose";
import { effectiveContracts } from "./insuranceContracts";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";
import Office from "../Models/Office";
import DoctorProfile from "../Models/DoctorProfile";

export type InsuranceNetwork = {
  doctors: number;
  clinics: number;
  hospitals: number;
  paraClinics: number;
  pharmacies: number;
};

type Id = mongoose.Types.ObjectId | string;

// The doctors who accept each insurer, by the same rule the booking quote
// applies (Lib/insuranceTariffs.ts acceptedInsurances): an effective
// insurer contract of the doctor's own (Models/InsuranceContract.ts) or,
// for an in-person visit, of the clinic or hospital their office is in.
// Before (2026-10) the /book filter and the network counts read only the
// doctor's own list, so a doctor whose clinic holds the Tamin contract was
// priced with Tamin at booking but never found by "who takes Tamin"; and
// the list was one-sided (the doctor typed it, the insurer never agreed):
// only an Active contract inside its validity counts now. Active doctors,
// active offices and active centres only (a switched-off centre lends no
// contract, as in the quote).
// `centres: false`: the doctor's own contracts only (online visits: a
// centre's insurers apply to an in-person visit at its office).
export const doctorsAcceptingInsurances = async (ids: Id[], { centres = true }: { centres?: boolean } = {}) => {
  const objectIds = ids.filter((el) => mongoose.isValidObjectId(String(el))).map((el) => new mongoose.Types.ObjectId(String(el)));
  const out = new Map<string, Set<string>>(objectIds.map((id) => [String(id), new Set<string>()]));
  if (!objectIds.length) return out;
  const contracts = await effectiveContracts({
    insurance: { $in: objectIds },
    providerKind: { $in: centres ? ["doctor", "clinic", "hospital"] : ["doctor"] },
  });
  const own = contracts.filter((c) => c.providerKind === "doctor");
  const centreIds = (kind: "clinic" | "hospital") => [...new Set(contracts.filter((c) => c.providerKind === kind).map((c) => c.provider))];
  const [clinics, hospitals] = await Promise.all([
    centreIds("clinic").length ? Clinic.find({ _id: { $in: centreIds("clinic") }, active: true }).select("_id").lean<{ _id: unknown }[]>() : [],
    centreIds("hospital").length ? Hospital.find({ _id: { $in: centreIds("hospital") }, isActive: true }).select("_id").lean<{ _id: unknown }[]>() : [],
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
  const liveCentres = new Set([...clinics, ...hospitals].map((c) => String(c._id)));
  const centreInsurances = new Map<string, string[]>();
  for (const c of contracts)
    if (c.providerKind !== "doctor" && liveCentres.has(c.provider))
      centreInsurances.set(c.provider, [...(centreInsurances.get(c.provider) || []), c.insurance]);
  const pairs: [string, string][] = [];
  for (const r of own) pairs.push([r.insurance, r.provider]);
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
// take it (their own contract, or the centre of their office: the booking's
// rule, doctorsAcceptingInsurances above) and the active centres with an
// effective contract - counted live, not typed in by hand (the old
// doctorsCount / centersCount fields drifted).
export const getInsuranceNetworks = async (ids: Id[]) => {
  const objectIds = ids.filter((el) => mongoose.isValidObjectId(String(el))).map((el) => new mongoose.Types.ObjectId(String(el)));
  const [doctors, centres] = await Promise.all([
    doctorsAcceptingInsurances(objectIds),
    acceptingCentres(objectIds),
  ]);
  return new Map<string, InsuranceNetwork>(
    objectIds.map((id) => {
      const key = String(id);
      const of = (kind: CentreKind) => centres.filter((c) => c.kind === kind && c.insurance === key).length;
      return [
        key,
        {
          doctors: doctors.get(key)?.size || 0,
          clinics: of("clinic"),
          hospitals: of("hospital"),
          paraClinics: of("paraClinic"),
          pharmacies: of("pharmacy"),
        },
      ];
    }),
  );
};

type CentreKind = "clinic" | "hospital" | "paraClinic" | "pharmacy";

// the active centres, labs and pharmacies with an effective contract with
// these insurers (one row per insurer and centre)
export const acceptingCentres = async (ids: Id[]) => {
  const objectIds = ids.filter((el) => mongoose.isValidObjectId(String(el))).map((el) => new mongoose.Types.ObjectId(String(el)));
  if (!objectIds.length) return [] as { kind: CentreKind; provider: string; insurance: string }[];
  const contracts = await effectiveContracts({
    insurance: { $in: objectIds },
    providerKind: { $in: ["clinic", "hospital", "paraClinic", "pharmacy"] },
  });
  const kinds: [CentreKind, mongoose.Model<any>, string][] = [
    ["clinic", Clinic, "active"],
    ["hospital", Hospital, "isActive"],
    ["paraClinic", ParaClinic, "active"],
    ["pharmacy", Pharmacy, "active"],
  ];
  const live = new Set<string>();
  await Promise.all(
    kinds.map(async ([kind, Model, field]) => {
      const pids = [...new Set(contracts.filter((c) => c.providerKind === kind).map((c) => c.provider))];
      if (!pids.length) return;
      const rows = await Model.find({ _id: { $in: pids }, [field]: true }).select("_id").lean<{ _id: unknown }[]>();
      for (const r of rows) live.add(`${kind}:${String(r._id)}`);
    }),
  );
  return contracts
    .filter((c) => live.has(`${c.providerKind}:${c.provider}`))
    .map((c) => ({ kind: c.providerKind as CentreKind, provider: c.provider, insurance: c.insurance }));
};
