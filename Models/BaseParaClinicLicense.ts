import { translatable } from "../Lib/i18n/translatable";
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
  // Noyan Business (2026-10, Lib/business): the books - accounts, vouchers,
  // ledger and statements; always posted, this opens the pages
  "accounting",
  // Noyan Business phase 2 (2026-10, Lib/business/inventory.ts): stock with
  // batches and expiry, the kardex, suppliers and purchases
  "inventory",
  // Noyan Business phase 3 (2026-10, Lib/business/payroll.ts): employees,
  // payslips with insurance and tax, salary and insurance payments
  "payroll",
  // Noyan Business phase 4 (2026-10, Lib/business/crm.ts, campaign.ts):
  // patients and customers, follow-ups, SMS campaigns
  "crm",
  // Noyan Business phase 5 (2026-10, Lib/moadian): electronic invoices
  // sent to the Moadian system
  "moadian",
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
  // campaign SMS parts included each Jalali month (2026-10, Lib/business/
  // campaign.ts); beyond it a campaign is paid from the Noyan wallet
  monthlySmsQuota: number;
  // Replaces the old flat monthlyPrice/monthlyDiscount/annualPrice/
  // annualDiscount fields (2026-09) - one pricing option per
  // period (days, stored on the option). See
  // Models/BaseLicensePricing.ts for the shared shape.
  pricing: IBaseLicensePricing[];
  descriptions: string[];
  modules: ParaClinicDashboardModule[];
  isRecommended: boolean;
  isDiscounted: boolean;
  isActive: boolean;
  // Marks a plan as part of the "primary" lineup shown on the main license
  // page (paraClinicController.getMyLicenseOverview filters on isActive AND
  // isPrimary) - an isActive plan that isn't isPrimary is still purchasable
  // via its direct id (getLicenseById) or the "see all plans" listing
  // (getActiveLicenses), just not featured on the main page.
  isPrimary: boolean;
  isGolden: boolean;
  summary: string;
  details: string;
}

const BaseParaClinicLicenseSchema = new mongoose.Schema<
  IBaseParaClinicLicense,
  Model<IBaseParaClinicLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  monthlySmsQuota: { type: Number, default: 0, min: 0, max: 1000000 },
  pricing: { type: [BaseLicensePricingSchema], default: [] },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: paraClinicDashboardModules, default: [] },
  isRecommended: { type: Boolean, default: false },
  isDiscounted: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  isPrimary: { type: Boolean, default: false },
  isGolden: { type: Boolean, default: false },
  summary: { type: String },
  details: { type: String },
});

BaseParaClinicLicenseSchema.plugin(translatable);

// one default plan at a time: marking a plan default clears the others
// (with two defaults, which one a new provider got was arbitrary)
const clearOtherDefaults = async (doc: { _id: unknown; isDefault?: boolean } | null) => {
  if (!doc?.isDefault) return;
  await mongoose
    .model("BaseParaClinicLicense")
    .updateMany({ _id: { $ne: doc._id }, isDefault: true }, { $set: { isDefault: false } });
};
BaseParaClinicLicenseSchema.post("save", clearOtherDefaults);
BaseParaClinicLicenseSchema.post("findOneAndUpdate", clearOtherDefaults);

const BaseParaClinicLicense = mongoose.model(
  "BaseParaClinicLicense",
  BaseParaClinicLicenseSchema,
);

export default BaseParaClinicLicense;
