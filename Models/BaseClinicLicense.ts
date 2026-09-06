import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  IBaseLicensePricing,
  BaseLicensePricingSchema,
} from "./BaseLicensePricing";

// Menu items available in the clinic dashboard (ClinicPanelSidebar). Kept in
// sync with the `title` values in Components/Layout/ClinicPabelSidebar.tsx
// on noyanai-front (excluding "logout", which is an action, not a menu).
// Mirrors the doctor/pharmacy versions at Models/BaseDoctorLicense.ts and
// Models/BasePharmacyLicense.ts (2026-09) — see that file's comment for the
// overall license/module-gating design.
export const clinicDashboardModules = [
  "profile",
  "secrataries",
  "prescriptions",
  "licenses",
  "articles",
] as const;

export type ClinicDashboardModule = (typeof clinicDashboardModules)[number];

export interface IBaseClinicLicense extends MongoDoc {
  displayName?: string;
  order: number;
  // Marks the tier a clinic with no license yet is treated as being on, or
  // pre-selected as the suggested plan on the purchase page - at most one
  // tier is expected to have this set, but it isn't DB-enforced.
  isDefault: boolean;
  // Replaces the old flat monthlyPrice/monthlyDiscount/annualPrice/
  // annualDiscount fields (2026-09) - one pricing option per
  // Models/LicenseDuration.ts catalog entry. See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: ClinicDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  details: string;
}

const BaseClinicLicenseSchema = new mongoose.Schema<
  IBaseClinicLicense,
  Model<IBaseClinicLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  pricing: { type: [BaseLicensePricingSchema], default: [] },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: clinicDashboardModules, default: [] },
  isRecommended: { type: Boolean, default: false },
  isDiscounted: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  details: { type: String },
});

const BaseClinicLicense = mongoose.model(
  "BaseClinicLicense",
  BaseClinicLicenseSchema,
);

export default BaseClinicLicense;
