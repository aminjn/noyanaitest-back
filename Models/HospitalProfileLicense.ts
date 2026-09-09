import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IHospital } from "./Hospital";
import {
  hospitalDashboardModules,
  HospitalDashboardModule,
  IBaseHospitalLicense,
} from "./BaseHospitalLicense";

// The license currently assigned to a hospital profile (2026-09) - one
// document per hospital (unique-indexed on `owner`), tracking which dashboard
// modules that hospital currently has access to. Contrast with
// Models/BaseHospitalLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a tier's
// modules can be copied onto a hospital's own license record. Mirrors the
// doctor/pharmacy versions at Models/DoctorProfileLicense.ts and
// Models/PharmacyProfileLicense.ts.
export interface IHospitalProfileLicense extends MongoDoc {
  owner: IHospital;
  // Defaults to the purchased BaseHospitalLicense's own displayName when a
  // hospital buys a license themselves (see hospitalController.purchaseLicense),
  // but an admin assigning/editing a hospital's license by hand can freely
  // override it with their own label.
  displayName?: string;
  modules: HospitalDashboardModule[];
  // Reference to the BaseHospitalLicense tier this record was purchased from
  // (2026-09) - unset for records created before this field existed, or a
  // hand-assigned license with no catalog tier behind it. Not authoritative
  // for access control (`modules` above is) - just a pointer back to the
  // plan for display/reference.
  baseLicense?: mongoose.Types.ObjectId | IBaseHospitalLicense;
  // When this license period started/expires (2026-09) - set from the
  // chosen LicenseDuration on purchase (hospitalController.purchaseLicense).
  // `expiresAt` unset means the license never expires (a hand-assigned
  // license, or a pre-2026-09 record) - see resolveMyLicenseModules, which
  // treats an expired license the same as no license at all.
  startedAt?: Date;
  expiresAt?: Date;
}

const HospitalProfileLicenseSchema = new mongoose.Schema<
  IHospitalProfileLicense,
  Model<IHospitalProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "Hospital",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: { type: [String], enum: hospitalDashboardModules, default: [] },
    baseLicense: { type: mongoose.Schema.ObjectId, ref: "BaseHospitalLicense" },
    startedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const HospitalProfileLicense = mongoose.model(
  "HospitalProfileLicense",
  HospitalProfileLicenseSchema,
);

export default HospitalProfileLicense;
