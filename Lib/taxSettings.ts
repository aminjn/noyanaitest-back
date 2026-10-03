import mongoose from "mongoose";
import MoadianProfile from "../Models/MoadianProfile";
import { Types } from "mongoose";
import PharmacyTaxSettings from "../Models/PharmacyTaxSettings";
import DoctorTaxSettings from "../Models/DoctorTaxSettings";
import ClinicTaxSettings from "../Models/ClinicTaxSettings";
import HospitalTaxSettings from "../Models/HospitalTaxSettings";
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

// A hospital's own visit tax rate, or null when the admin set none (then
// the doctor's rate applies - there is no platform-wide hospital default,
// Models/HospitalTaxSettings.ts).
export const getHospitalTaxPercent = async (
  hospitalId: OrgId,
): Promise<number | null> => {
  const doc = await HospitalTaxSettings.findOne({ hospital: hospitalId });
  return doc?.taxPercent ?? null;
};

const idOf = (value: unknown): OrgId | undefined =>
  value && typeof value === "object" && "_id" in (value as object)
    ? ((value as { _id?: OrgId })._id as OrgId)
    : (value as OrgId | undefined);

// The seller of record charges VAT only when it is registered with Moadian
// (2026-10): its own active profile with an economic code. An unregistered
// doctor or centre can't issue the e-invoice that declares the tax, so no
// tax is added (most medical services are VAT-exempt for them anyway).
const registrationCache = new Map<string, { at: number; value: boolean }>();
export const isVatRegistered = async (
  kind: "doctor" | "clinic" | "hospital" | "pharmacy" | "paraClinic",
  id: OrgId | undefined,
): Promise<boolean> => {
  if (!id) return false;
  const key = `${kind}:${String(id)}`;
  const hit = registrationCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = !!(await MoadianProfile.exists({
    ownerKind: kind,
    ownerId: new mongoose.Types.ObjectId(String(id)),
    isActive: true,
    economicCode: { $nin: [null, ""] },
  }));
  registrationCache.set(key, { at: Date.now(), value });
  return value;
};
export const clearVatRegistrationCache = () => registrationCache.clear();

// The visit tax of one booking (2026-10). The doctor is paid and is the
// seller of record, so nothing is added unless the doctor is registered.
// The rate, one precedence for every kind of office: the place of service's
// own rate (clinic or hospital, when the admin set one), else the doctor's
// own visit rate, else the platform's doctor-visit default.
export const getVisitTaxPercent = async (
  doctorId: OrgId,
  office?: { clinic?: unknown; hospital?: unknown } | null,
  global?: IGlobalTaxSettings | null,
): Promise<number> => {
  if (!(await isVatRegistered("doctor", doctorId))) return 0;
  const clinicId = idOf(office?.clinic);
  if (clinicId) {
    const own = await ClinicTaxSettings.findOne({ clinic: clinicId });
    if (own?.taxPercent != null) return own.taxPercent;
  }
  const hospitalId = idOf(office?.hospital);
  if (hospitalId) {
    const own = await getHospitalTaxPercent(hospitalId);
    if (own != null) return own;
  }
  return getDoctorVisitTaxPercent(doctorId, global);
};

// Tax is always additive on top of the (already discount-adjusted) price a
// buyer sees - it never changes that displayed price, only what gets added
// at checkout (2026-09 user decision). Rounded to the nearest whole
// currency unit, same rounding style as the rest of the money math in this
// codebase (plain integers, no fractional Toman).
export const calcTax = (amount: number, percent: number): number =>
  Math.round((amount * percent) / 100);
