import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Singleton document holding the platform-wide default tax rates (2026-09,
// requested by the user alongside per-organization tax fields on
// Pharmacy/DoctorProfile/Clinic/ParaClinic). Used as the fallback tax
// percent for a sellable action that doesn't have its own tax field set on
// its org-specific *TaxSettings doc (Models/PharmacyTaxSettings.ts /
// Models/DoctorTaxSettings.ts / Models/ClinicTaxSettings.ts /
// Models/ParaClinicTaxSettings.ts) - mirrors Models/GlobalFinanceSettings.ts
// exactly, just for tax instead of commission. Admin-managed via
// Routers/autoRouter.ts (registered with `singleton: true`), read+written by
// Lib/taxSettings.ts's lookup-with-fallback helpers.
export interface IGlobalTaxSettings extends MongoDoc {
  singleton: "SINGLETON";

  // Default tax percents (0-100) applied when the corresponding
  // organization/sellable-action has no tax field set of its own.
  defaultPharmacyTaxPercent: number;
  // DoctorProfile has two independent sellable actions - a booked
  // visit/session (Controllers/bookingController.ts submitBookingNew) and a
  // Service/ServicePackage sold through the cart - so it gets two defaults,
  // not one.
  defaultDoctorVisitTaxPercent: number;
  defaultDoctorServiceTaxPercent: number;
  defaultClinicTaxPercent: number;
  defaultParaClinicTaxPercent: number;
}

const GlobalTaxSettingsSchema = new mongoose.Schema<
  IGlobalTaxSettings,
  Model<IGlobalTaxSettings>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  defaultPharmacyTaxPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultDoctorVisitTaxPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultDoctorServiceTaxPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultClinicTaxPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  defaultParaClinicTaxPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
});

const GlobalTaxSettings = mongoose.model(
  "GlobalTaxSettings",
  GlobalTaxSettingsSchema,
);

export default GlobalTaxSettings;
