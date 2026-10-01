import { Types } from "mongoose";
import PharmacyTaxSettings from "../Models/PharmacyTaxSettings";
import DoctorTaxSettings from "../Models/DoctorTaxSettings";
import ClinicTaxSettings from "../Models/ClinicTaxSettings";
import ParaClinicTaxSettings from "../Models/ParaClinicTaxSettings";
import GlobalTaxSettings, {
  IGlobalTaxSettings,
} from "../Models/GlobalTaxSettings";

// Lookup-with-fallback helpers for the tax system (2026-09) - the pattern
// Models/GlobalFinanceSettings.ts's own comment invited ("whoever consumes
// this next should probably add [a helper]") but commission itself never
// got one. Every "effective tax percent" question in the app should go
// through one of these instead of re-implementing the
// try-org-doc-then-fall-back-to-global lookup inline.
//
// `global` may be passed in by a caller that's resolving several rates in
// one request (e.g. a mixed cart) to avoid re-fetching the
// GlobalTaxSettings singleton once per line item.

export const getGlobalTaxSettings = async (): Promise<
  IGlobalTaxSettings | null
> => GlobalTaxSettings.findOne();

type OrgId = Types.ObjectId | string;

export const getPharmacyTaxPercent = async (
  pharmacyId: OrgId,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const doc = await PharmacyTaxSettings.findOne({ pharmacy: pharmacyId });
  if (doc?.taxPercent != null) return doc.taxPercent;
  const g = global === undefined ? await getGlobalTaxSettings() : global;
  return g?.defaultPharmacyTaxPercent ?? 0;
};

export const getDoctorVisitTaxPercent = async (
  doctorId: OrgId,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const doc = await DoctorTaxSettings.findOne({ doctor: doctorId });
  if (doc?.visitTaxPercent != null) return doc.visitTaxPercent;
  const g = global === undefined ? await getGlobalTaxSettings() : global;
  return g?.defaultDoctorVisitTaxPercent ?? 0;
};

export const getDoctorServiceTaxPercent = async (
  doctorId: OrgId,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const doc = await DoctorTaxSettings.findOne({ doctor: doctorId });
  if (doc?.serviceTaxPercent != null) return doc.serviceTaxPercent;
  const g = global === undefined ? await getGlobalTaxSettings() : global;
  return g?.defaultDoctorServiceTaxPercent ?? 0;
};

// Applied to in-person visits held in an office inside the clinic
// (getVisitTaxPercent below): the clinic is the place of service.
export const getClinicTaxPercent = async (
  clinicId: OrgId,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const doc = await ClinicTaxSettings.findOne({ clinic: clinicId });
  if (doc?.taxPercent != null) return doc.taxPercent;
  const g = global === undefined ? await getGlobalTaxSettings() : global;
  return g?.defaultClinicTaxPercent ?? 0;
};

export const getParaClinicTaxPercent = async (
  paraClinicId: OrgId,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const doc = await ParaClinicTaxSettings.findOne({
    paraClinic: paraClinicId,
  });
  if (doc?.taxPercent != null) return doc.taxPercent;
  const g = global === undefined ? await getGlobalTaxSettings() : global;
  return g?.defaultParaClinicTaxPercent ?? 0;
};

// The visit tax of one booking (2026-10): an in-person visit in an office
// that belongs to a clinic is taxed at that clinic's rate (the clinic is
// the place of service, as on Doctolib / Paziresh24 clinic bookings);
// every other visit at the doctor's own visit rate. Never both.
export const getVisitTaxPercent = async (
  doctorId: OrgId,
  office?: { clinic?: unknown } | null,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  const clinic = office?.clinic as { _id?: OrgId } | OrgId | undefined;
  const clinicId =
    clinic && typeof clinic === "object" && "_id" in clinic ? clinic._id : clinic;
  if (clinicId) return getClinicTaxPercent(clinicId as OrgId, global);
  return getDoctorVisitTaxPercent(doctorId, global);
};

// Tax is always additive on top of the (already discount-adjusted) price a
// buyer sees - it never changes that displayed price, only what gets added
// at checkout (2026-09 user decision). Rounded to the nearest whole
// currency unit, same rounding style as the rest of the money math in this
// codebase (plain integers, no fractional Toman).
export const calcTax = (amount: number, percent: number): number =>
  Math.round((amount * percent) / 100);
