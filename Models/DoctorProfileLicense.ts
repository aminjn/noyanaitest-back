import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import {
  doctorDashboardModules,
  DoctorDashboardModule,
} from "./BaseDoctorLicense";

// The license currently assigned to a doctor profile (2026-09) - one
// document per doctor (unique-indexed on `owner`), tracking which
// dashboard modules that doctor currently has access to. Contrast with
// Models/BaseDoctorLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a
// tier's modules can be copied onto a doctor's own license record.
export interface IDoctorProfileLicense extends MongoDoc {
  owner: IDoctorProfile;
  // Defaults to the purchased BaseDoctorLicense's own displayName when a
  // doctor buys a license themselves (see doctorController.purchaseLicense),
  // but an admin assigning/editing a doctor's license by hand can freely
  // override it with their own label.
  displayName?: string;
  modules: DoctorDashboardModule[];
}

const DoctorProfileLicenseSchema = new mongoose.Schema<
  IDoctorProfileLicense,
  Model<IDoctorProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: { type: [String], enum: doctorDashboardModules, default: [] },
  },
  { timestamps: true },
);

const DoctorProfileLicense = mongoose.model(
  "DoctorProfileLicense",
  DoctorProfileLicenseSchema,
);

export default DoctorProfileLicense;
