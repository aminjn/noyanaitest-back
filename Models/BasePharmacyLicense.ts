import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Menu items available in the pharmacy dashboard (PharmacyPanelSidebar).
// Kept in sync with the `title` values in
// Components/Layout/PharmacyPanelSidebar.tsx on noyanai-front (excluding
// "logout", which is an action, not a menu). Mirrors the doctor version at
// Models/BaseDoctorLicense.ts (2026-09) — see that file's comment for the
// overall license/module-gating design.
export const pharmacyDashboardModules = [
  "profile",
  "secrataries",
  "products",
  "productPackages",
  "incomingOrders",
  "licenses",
  "prescriptions",
  "tamin",
  "articles",
] as const;

export type PharmacyDashboardModule = (typeof pharmacyDashboardModules)[number];

export interface IBasePharmacyLicense extends MongoDoc {
  displayName?: string;
  order: number;
  // Marks the tier a pharmacy with no license yet is treated as being on, or
  // pre-selected as the suggested plan on the purchase page - at most one
  // tier is expected to have this set, but it isn't DB-enforced.
  isDefault: boolean;
  monthlyPrice: number;
  monthlyDiscount: number;
  annualPrice: number;
  annualDiscount: number;
  descriptions: string[];
  modules: PharmacyDashboardModule[];
}

const BasePharmacyLicenseSchema = new mongoose.Schema<
  IBasePharmacyLicense,
  Model<IBasePharmacyLicense>
>({
  displayName: { type: String },
  order: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
  monthlyPrice: { type: Number, default: 0 },
  monthlyDiscount: { type: Number, default: 0 },
  annualPrice: { type: Number, default: 0 },
  annualDiscount: { type: Number, default: 0 },
  descriptions: { type: [String], default: [] },
  modules: { type: [String], enum: pharmacyDashboardModules, default: [] },
});

const BasePharmacyLicense = mongoose.model(
  "BasePharmacyLicense",
  BasePharmacyLicenseSchema,
);

export default BasePharmacyLicense;
