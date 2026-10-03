import { translatable } from "../Lib/i18n/translatable";
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
  // Noyan Business (2026-10, Lib/business): the books - accounts, vouchers,
  // ledger and statements; always posted, this opens the pages
  "accounting",
  // Noyan Business phase 2 (2026-10, Lib/business/inventory.ts): stock with
  // batches and expiry, the kardex, suppliers and purchases
  "inventory",
  // Noyan Business phase 3 (2026-10, Lib/business/payroll.ts): employees,
  // payslips with insurance and tax, salary and insurance payments
  "payroll",
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
  // period (days, stored on the option). See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: ClinicDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  // Marks a plan as part of the "primary" lineup shown on the main license
  // page (clinicController.getMyLicenseOverview filters on isActive AND
  // isPrimary) - an isActive plan that isn't isPrimary is still purchasable
  // via its direct id (getLicenseById) or the "see all plans" listing
  // (getActiveLicenses), just not featured on the main page.
  isPrimary: boolean;
  isGolden: boolean;
  summary: string;
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
  isPrimary: { type: Boolean, default: false },
  isGolden: { type: Boolean, default: false },
  summary: { type: String },
  details: { type: String },
});

BaseClinicLicenseSchema.plugin(translatable);

// one default plan at a time: marking a plan default clears the others
// (with two defaults, which one a new provider got was arbitrary)
const clearOtherDefaults = async (doc: { _id: unknown; isDefault?: boolean } | null) => {
  if (!doc?.isDefault) return;
  await mongoose
    .model("BaseClinicLicense")
    .updateMany({ _id: { $ne: doc._id }, isDefault: true }, { $set: { isDefault: false } });
};
BaseClinicLicenseSchema.post("save", clearOtherDefaults);
BaseClinicLicenseSchema.post("findOneAndUpdate", clearOtherDefaults);

const BaseClinicLicense = mongoose.model(
  "BaseClinicLicense",
  BaseClinicLicenseSchema,
);

export default BaseClinicLicense;
