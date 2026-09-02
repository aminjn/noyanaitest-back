import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";
import {
  clinicDashboardModules,
  ClinicDashboardModule,
} from "./BaseClinicLicense";

// The license currently assigned to a clinic profile (2026-09) - one
// document per clinic (unique-indexed on `owner`), tracking which dashboard
// modules that clinic currently has access to. Contrast with
// Models/BaseClinicLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a tier's
// modules can be copied onto a clinic's own license record. Mirrors the
// doctor/pharmacy versions at Models/DoctorProfileLicense.ts and
// Models/PharmacyProfileLicense.ts.
export interface IClinicProfileLicense extends MongoDoc {
  owner: IClinic;
  // Defaults to the purchased BaseClinicLicense's own displayName when a
  // clinic buys a license themselves (see clinicController.purchaseLicense),
  // but an admin assigning/editing a clinic's license by hand can freely
  // override it with their own label.
  displayName?: string;
  modules: ClinicDashboardModule[];
}

const ClinicProfileLicenseSchema = new mongoose.Schema<
  IClinicProfileLicense,
  Model<IClinicProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "Clinic",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: { type: [String], enum: clinicDashboardModules, default: [] },
  },
  { timestamps: true },
);

const ClinicProfileLicense = mongoose.model(
  "ClinicProfileLicense",
  ClinicProfileLicenseSchema,
);

export default ClinicProfileLicense;
