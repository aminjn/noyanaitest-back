import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import {
  pharmacyDashboardModules,
  PharmacyDashboardModule,
} from "./BasePharmacyLicense";

// The license currently assigned to a pharmacy profile (2026-09) - one
// document per pharmacy (unique-indexed on `owner`), tracking which
// dashboard modules that pharmacy currently has access to. Contrast with
// Models/BasePharmacyLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a
// tier's modules can be copied onto a pharmacy's own license record.
// Mirrors the doctor version at Models/DoctorProfileLicense.ts.
export interface IPharmacyProfileLicense extends MongoDoc {
  owner: IPharmacy;
  // Defaults to the purchased BasePharmacyLicense's own displayName when a
  // pharmacy buys a license themselves (see
  // pharmacyController.purchaseLicense), but an admin assigning/editing a
  // pharmacy's license by hand can freely override it with their own label.
  displayName?: string;
  modules: PharmacyDashboardModule[];
}

const PharmacyProfileLicenseSchema = new mongoose.Schema<
  IPharmacyProfileLicense,
  Model<IPharmacyProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "Pharmacy",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: { type: [String], enum: pharmacyDashboardModules, default: [] },
  },
  { timestamps: true },
);

const PharmacyProfileLicense = mongoose.model(
  "PharmacyProfileLicense",
  PharmacyProfileLicenseSchema,
);

export default PharmacyProfileLicense;
