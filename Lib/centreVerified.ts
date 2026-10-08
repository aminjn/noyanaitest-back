import mongoose, { Model } from "mongoose";
import { ICentreLicence } from "../Models/CentreLicence";

// The verified tick of a centre (2026-10, owner decision).
//
// Doctolib and Zocdoc show a "verified" mark only for a practice whose
// registration the platform checked (Doctolib against the RPPS / FINESS
// registers, Zocdoc against the state licence), and drop it when the
// licence lapses; Paziresh24 and Doctoreto show it for a centre whose
// پروانه (operating licence, siam code) the staff saw. NoyanAI's tick used
// to mean "has an owner account" - any claimed centre, licence or not.
// Now it means: a licence number the staff approved (the become-request's
// siam / Central Insurance code, or set by the admin) that has not expired.
// One rule, used by every endpoint that feeds the shared centre card (FE
// Components/UI/CentreCard) and the centre pages: lists, search, map,
// booking pages, a test's labs, an insurer's network, the detail pages.

export const centreKinds = ["clinic", "hospital", "pharmacy", "paraClinic", "insurance"] as const;
export type CentreKind = (typeof centreKinds)[number];

// where each kind keeps its licence number (it had these before the tick
// was tied to the licence; pharmacy and lab got licenseNumber)
export const centreLicenceNumberField: Record<CentreKind, "clinicCode" | "code" | "licenseNumber"> = {
  clinic: "clinicCode",
  hospital: "code",
  pharmacy: "licenseNumber",
  paraClinic: "licenseNumber",
  insurance: "licenseNumber",
};

export const centreModelName: Record<CentreKind, string> = {
  clinic: "Clinic",
  hospital: "Hospital",
  pharmacy: "Pharmacy",
  paraClinic: "ParaClinic",
  insurance: "Insurance",
};

export const centreModel = (kind: CentreKind): Model<any> => mongoose.model(centreModelName[kind]);

// what a query must select for centreVerified (add to a .select([...]) or
// a $project)
export const centreVerifiedFields = (kind: CentreKind): string[] => [
  centreLicenceNumberField[kind],
  "licence.verifiedAt",
  "licence.expiresAt",
];
export const centreVerifiedProject = (kind: CentreKind): Record<string, 1> =>
  Object.fromEntries(centreVerifiedFields(kind).map((f) => [f, 1]));

type LicenceLike = { licence?: Partial<ICentreLicence> | null } & Record<string, unknown>;

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

// The rule: a licence number, approved by the staff, not expired. A centre
// read without these fields reads as not verified (nothing invented).
export const centreVerified = (kind: CentreKind, centre: unknown, now: Date = new Date()): boolean => {
  if (!centre || typeof centre !== "object") return false;
  const c = centre as LicenceLike;
  const number = c[centreLicenceNumberField[kind]];
  if (typeof number !== "string" || !number.trim()) return false;
  const licence = c.licence && typeof c.licence === "object" ? c.licence : null;
  if (!licence || !asDate(licence.verifiedAt)) return false;
  const expiresAt = asDate(licence.expiresAt);
  return !expiresAt || expiresAt.getTime() > now.getTime();
};

const plainOf = (row: unknown): Record<string, any> => {
  if (!row || typeof row !== "object") return {};
  const r = row as { toJSON?: () => Record<string, any> };
  return typeof r.toJSON === "function" ? r.toJSON() : { ...(row as Record<string, any>) };
};

// A centre as the public sees it: `verified` set by the rule; the licence
// record itself (who verified it, when) and the panel owner's account are
// left out (the tick used to be inferred from `user`).
export const withCentreVerified = <T = Record<string, any>>(kind: CentreKind, row: unknown, now: Date = new Date()): T => {
  if (!row || typeof row !== "object") return row as T;
  const plain = plainOf(row);
  const verified = centreVerified(kind, plain, now);
  delete plain.licence;
  delete plain.claimed;
  delete plain.user;
  plain.verified = verified;
  return plain as T;
};

export const withCentresVerified = <T = Record<string, any>>(kind: CentreKind, rows: unknown, now: Date = new Date()): T[] =>
  (Array.isArray(rows) ? rows : []).map((row) => withCentreVerified<T>(kind, row, now));

// the kind of a centre model name ("Clinic" -> "clinic"), for code that
// holds a model
export const centreKindOfModel = (modelName: string): CentreKind | null => {
  const hit = (Object.keys(centreModelName) as CentreKind[]).find((k) => centreModelName[k] === modelName);
  return hit || null;
};
