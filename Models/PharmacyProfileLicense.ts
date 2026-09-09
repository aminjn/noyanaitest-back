import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import {
  pharmacyDashboardModules,
  PharmacyDashboardModule,
  IBasePharmacyLicense,
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
  // Reference to the BasePharmacyLicense tier this record was purchased
  // from (2026-09) - unset for records created before this field existed,
  // or a hand-assigned license with no catalog tier behind it. Not
  // authoritative for access control (`modules` above is) - just a
  // pointer back to the plan for display/reference.
  baseLicense?: mongoose.Types.ObjectId | IBasePharmacyLicense;
  // When this license period started/expires (2026-09) - set from the
  // chosen LicenseDuration on purchase (pharmacyController.purchaseLicense).
  // `expiresAt` unset means the license never expires (a hand-assigned
  // license, or a pre-2026-09 record) - see resolveMyLicenseModules, which
  // treats an expired license the same as no license at all.
  startedAt?: Date;
  expiresAt?: Date;
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
    baseLicense: {
      type: mongoose.Schema.ObjectId,
      ref: "BasePharmacyLicense",
    },
    startedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const PharmacyProfileLicense = mongoose.model(
  "PharmacyProfileLicense",
  PharmacyProfileLicenseSchema,
);

export default PharmacyProfileLicense;
