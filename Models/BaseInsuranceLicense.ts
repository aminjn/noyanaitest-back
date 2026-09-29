import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  IBaseLicensePricing,
  BaseLicensePricingSchema,
} from "./BaseLicensePricing";

// Menu items available in the insurance dashboard (InsurancePanelSidebar).
// Kept in sync with the `title` values in
// Components/Layout/InsurancePanelSidebar.tsx on noyanai-front (excluding
// "logout", which is an action, not a menu). Mirrors the hospital/doctor/
// pharmacy versions at Models/BaseHospitalLicense.ts/BaseDoctorLicense.ts/
// BasePharmacyLicense.ts (2026-09) — see that file's comment for the overall
// license/module-gating design.
export const insuranceDashboardModules = [
  "profile",
  "secrataries",
  "licenses",
  "articles",
] as const;

export type InsuranceDashboardModule =
  (typeof insuranceDashboardModules)[number];

export interface IBaseInsuranceLicense extends MongoDoc {
  displayName?: string;
  order: number;
  // Marks the tier an insurance with no license yet is treated as being on,
  // or pre-selected as the suggested plan on the purchase page - at most one
  // tier is expected to have this set, but it isn't DB-enforced.
  isDefault: boolean;
  // One pricing option per Models/LicenseDuration.ts catalog entry. See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: InsuranceDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  // Marks a plan as part of the "primary" lineup shown on the main license
  // page (insuranceController.getMyLicenseOverview filters on isActive AND
  // isPrimary) - an isActive plan that isn't isPrimary is still purchasable
  // via its direct id (getLicenseById) or the "see all plans" listing
  // (getActiveLicenses), just not featured on the main page.
  isPrimary: boolean;
  isGolden: boolean;
  summary: string;
  details: string;
}

const BaseInsuranceLicenseSchema = new mongoose.Schema<
  IBaseInsuranceLicense,
  Model<IBaseInsuranceLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  pricing: { type: [BaseLicensePricingSchema], default: [] },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: insuranceDashboardModules, default: [] },
  isRecommended: { type: Boolean, default: false },
  isDiscounted: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  isPrimary: { type: Boolean, default: false },
  isGolden: { type: Boolean, default: false },
  summary: { type: String },
  details: { type: String },
});

BaseInsuranceLicenseSchema.plugin(translatable);

// one default plan at a time: marking a plan default clears the others
// (with two defaults, which one a new provider got was arbitrary)
const clearOtherDefaults = async (doc: { _id: unknown; isDefault?: boolean } | null) => {
  if (!doc?.isDefault) return;
  await mongoose
    .model("BaseInsuranceLicense")
    .updateMany({ _id: { $ne: doc._id }, isDefault: true }, { $set: { isDefault: false } });
};
BaseInsuranceLicenseSchema.post("save", clearOtherDefaults);
BaseInsuranceLicenseSchema.post("findOneAndUpdate", clearOtherDefaults);

const BaseInsuranceLicense = mongoose.model(
  "BaseInsuranceLicense",
  BaseInsuranceLicenseSchema,
);

export default BaseInsuranceLicense;
