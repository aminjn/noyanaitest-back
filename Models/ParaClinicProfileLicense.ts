import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";
import {
  paraClinicDashboardModules,
  ParaClinicDashboardModule,
} from "./BaseParaClinicLicense";

// The license currently assigned to a paraClinic profile (2026-09) - one
// document per paraClinic (unique-indexed on `owner`), tracking which
// dashboard modules that paraClinic currently has access to. Contrast with
// Models/BaseParaClinicLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a tier's
// modules can be copied onto a paraClinic's own license record. Mirrors the
// doctor/pharmacy/clinic versions at Models/DoctorProfileLicense.ts,
// Models/PharmacyProfileLicense.ts and Models/ClinicProfileLicense.ts.
export interface IParaClinicProfileLicense extends MongoDoc {
  owner: IParaClinic;
  // Defaults to the purchased BaseParaClinicLicense's own displayName when a
  // paraClinic buys a license themselves (see
  // paraClinicController.purchaseLicense), but an admin assigning/editing a
  // paraClinic's license by hand can freely override it with their own
  // label.
  displayName?: string;
  modules: ParaClinicDashboardModule[];
}

const ParaClinicProfileLicenseSchema = new mongoose.Schema<
  IParaClinicProfileLicense,
  Model<IParaClinicProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "ParaClinic",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: {
      type: [String],
      enum: paraClinicDashboardModules,
      default: [],
    },
  },
  { timestamps: true },
);

const ParaClinicProfileLicense = mongoose.model(
  "ParaClinicProfileLicense",
  ParaClinicProfileLicenseSchema,
);

export default ParaClinicProfileLicense;
