import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import {
  doctorDashboardModules,
  DoctorDashboardModule,
  IBaseDoctorLicense,
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
  // Reference to the BaseDoctorLicense tier this record was purchased from
  // (2026-09) - unset for records created before this field existed, or a
  // hand-assigned license with no catalog tier behind it. Not authoritative
  // for access control (`modules` above is) - just a pointer back to the
  // plan for display/reference.
  baseLicense?: mongoose.Types.ObjectId | IBaseDoctorLicense;
  // When this license period started/expires (2026-09) - set from the
  // chosen price option's period (days) on purchase (doctorController.purchaseLicense).
  // `expiresAt` unset means the license never expires (a hand-assigned
  // license, or a pre-2026-09 record) - see resolveMyLicenseModules, which
  // treats an expired license the same as no license at all.
  startedAt?: Date;
  expiresAt?: Date;
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
    baseLicense: { type: mongoose.Schema.ObjectId, ref: "BaseDoctorLicense" },
    startedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const DoctorProfileLicense = mongoose.model(
  "DoctorProfileLicense",
  DoctorProfileLicenseSchema,
);

export default DoctorProfileLicense;
