import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Singleton document holding the platform-wide default commission rates
// (2026-08). Used as the fallback commission for a pharmacy/doctor/
// paraClinic that doesn't have its own Models/PharmacyFinanceSettings.ts /
// Models/DoctorFinanceSettings.ts / Models/ParaClinicFinanceSettings.ts doc
// yet (those are per-organization and only exist once an admin has set a
// custom rate for that specific organization). Admin-managed via
// Routers/autoRouter.ts (registered with `singleton: true`), mirroring
// Models/AppConfig.ts's singleton pattern.
export interface IGlobalFinanceSettings extends MongoDoc {
  singleton: "SINGLETON";

  // Default commission percents (0-100) applied when the corresponding
  // organization has no *FinanceSettings doc of its own.
  defaultPharmacyCommissionPercent: number;
  defaultDoctorCommissionPercent: number;
  // in-person visits: 0 by default - like Doctolib / Paziresh24, a doctor
  // pays the monthly plan for in-person booking, the commission is on
  // online consultations and on what is sold through the store
  defaultDoctorInPersonCommissionPercent: number;
  defaultParaClinicCommissionPercent: number;
}

const GlobalFinanceSettingsSchema = new mongoose.Schema<
  IGlobalFinanceSettings,
  Model<IGlobalFinanceSettings>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  defaultPharmacyCommissionPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultDoctorCommissionPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultDoctorInPersonCommissionPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultParaClinicCommissionPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
});

const GlobalFinanceSettings = mongoose.model(
  "GlobalFinanceSettings",
  GlobalFinanceSettingsSchema,
);

export default GlobalFinanceSettings;
