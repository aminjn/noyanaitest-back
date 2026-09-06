import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  IBaseLicensePricing,
  BaseLicensePricingSchema,
} from "./BaseLicensePricing";

// Menu items available in the paraClinic dashboard (ParaClinicSidebar). Kept
// in sync with the `target` values in Components/Layout/ParaClinicSidebar.tsx
// on noyanai-front (excluding "secretary", which is owner-only and never
// gated, same treatment doctor/pharmacy/clinic give their own
// secretary-management item). Mirrors the doctor/pharmacy/clinic versions at
// Models/BaseDoctorLicense.ts, Models/BasePharmacyLicense.ts and
// Models/BaseClinicLicense.ts (2026-09) — see that file's comment for the
// overall license/module-gating design.
export const paraClinicDashboardModules = [
  "profile",
  "secrataries",
  "tests",
  "incomingOrders",
  "tamin",
  "articles",
  "licenses",
] as const;

export type ParaClinicDashboardModule =
  (typeof paraClinicDashboardModules)[number];

export interface IBaseParaClinicLicense extends MongoDoc {
  displayName?: string;
  order: number;
  // Marks the tier a paraClinic with no license yet is treated as being on,
  // or pre-selected as the suggested plan on the purchase page - at most one
  // tier is expected to have this set, but it isn't DB-enforced.
  isDefault: boolean;
  // Replaces the old flat monthlyPrice/monthlyDiscount/annualPrice/
  // annualDiscount fields (2026-09) - one pricing option per
  // Models/LicenseDuration.ts catalog entry. See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: ParaClinicDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  details: string;
}

const BaseParaClinicLicenseSchema = new mongoose.Schema<
  IBaseParaClinicLicense,
  Model<IBaseParaClinicLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  pricing: { type: [BaseLicensePricingSchema], default: [] },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: paraClinicDashboardModules, default: [] },
  isRecommended: { type: Boolean, default: false },
  isDiscounted: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  details: { type: String },
});

const BaseParaClinicLicense = mongoose.model(
  "BaseParaClinicLicense",
  BaseParaClinicLicenseSchema,
);

export default BaseParaClinicLicense;
