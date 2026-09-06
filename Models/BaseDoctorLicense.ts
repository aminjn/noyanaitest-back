import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  IBaseLicensePricing,
  BaseLicensePricingSchema,
} from "./BaseLicensePricing";

// Menu items available in the doctor dashboard (DoctorSidebar). Kept in
// sync with the `title` values in Components/Layout/DoctorSidebar.tsx on
// noyanai-front (excluding "logout", which is an action, not a menu).
export const doctorDashboardModules = [
  "dashboard",
  "profile",
  "office",
  "services",
  "servicePackages",
  "incomingOrders",
  "financialMangement",
  "secrataries",
  "shifts",
  "schedule",
  "patients",
  "licenses",
  "clinics",
  "phrmaciesAndLabs",
  "insurances",
  "offers",
  "discounts",
  "articles",
  "chatWithPatients",
  "drugsAndPrescriptions",
  "patientDocuments",
  "settings",
] as const;

export type DoctorDashboardModule = (typeof doctorDashboardModules)[number];

export interface IBaseDoctorLicense extends MongoDoc {
  displayName?: string;
  order: number;
  // Marks the tier a doctor with no license yet is treated as being on, or
  // pre-selected as the suggested plan on the purchase page - at most one
  // tier is expected to have this set, but it isn't DB-enforced.
  isDefault: boolean;
  // Replaces the old flat monthlyPrice/monthlyDiscount/annualPrice/
  // annualDiscount fields (2026-09) - one pricing option per
  // Models/LicenseDuration.ts catalog entry. See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: DoctorDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  details: string;
}

const BaseDoctorLicenseSchema = new mongoose.Schema<
  IBaseDoctorLicense,
  Model<IBaseDoctorLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  pricing: { type: [BaseLicensePricingSchema], default: [] },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: doctorDashboardModules, default: [] },
  isRecommended: { type: Boolean, default: false },
  isDiscounted: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  details: { type: String },
});

const BaseDoctorLicense = mongoose.model(
  "BaseDoctorLicense",
  BaseDoctorLicenseSchema,
);

export default BaseDoctorLicense;
