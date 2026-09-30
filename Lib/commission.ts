import GlobalFinanceSettings from "../Models/GlobalFinanceSettings";
import DoctorFinanceSettings from "../Models/DoctorFinanceSettings";
import PharmacyFinanceSettings from "../Models/PharmacyFinanceSettings";
import ParaClinicFinanceSettings from "../Models/ParaClinicFinanceSettings";

// Platform commission (2026-09), the marketplace model of the leaders:
// taken from what a provider earns through NoyanAI at payout time, never
// added to the patient's price.
//  - doctor, online consultation (video / voice / chat / SIP) and doctor
//    services sold in the store -> doctor rate
//  - doctor, in-person visit -> in-person rate (0 by default: in-person
//    booking is paid for by the monthly plan, as on Doctolib / Paziresh24)
//  - pharmacy order lines -> pharmacy rate
//  - lab test order lines -> paraclinic rate
// A provider's own *FinanceSettings (set by an admin) overrides the
// platform default in GlobalFinanceSettings.

export type CommissionKind = "doctorOnline" | "doctorInPerson" | "pharmacy" | "paraClinic";

const clampPercent = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
};

export const getCommissionPercent = async (
  kind: CommissionKind,
  orgId?: unknown,
): Promise<number> => {
  const global = await GlobalFinanceSettings.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  if (kind === "doctorOnline" || kind === "doctorInPerson") {
    const own = orgId ? await DoctorFinanceSettings.findOne({ doctor: orgId }).lean() : null;
    if (kind === "doctorOnline")
      return clampPercent(own?.commissionPercent ?? global?.defaultDoctorCommissionPercent);
    return clampPercent(
      own?.inPersonCommissionPercent ?? global?.defaultDoctorInPersonCommissionPercent,
    );
  }
  if (kind === "pharmacy") {
    const own = orgId ? await PharmacyFinanceSettings.findOne({ pharmacy: orgId }).lean() : null;
    return clampPercent(own?.commissionPercent ?? global?.defaultPharmacyCommissionPercent);
  }
  const own = orgId ? await ParaClinicFinanceSettings.findOne({ paraClinic: orgId }).lean() : null;
  return clampPercent(own?.commissionPercent ?? global?.defaultParaClinicCommissionPercent);
};

// gross -> what the provider receives, and the platform's share
export const splitCommission = (gross: number, percent: number) => {
  const commission = Math.round((Math.max(0, gross) * percent) / 100);
  return { gross, commission, net: Math.max(0, gross - commission), percent };
};
