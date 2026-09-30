import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";
import {
  paraClinicDashboardModules,
  ParaClinicDashboardModule,
  IBaseParaClinicLicense,
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
  // Reference to the BaseParaClinicLicense tier this record was purchased
  // from (2026-09) - unset for records created before this field existed,
  // or a hand-assigned license with no catalog tier behind it. Not
  // authoritative for access control (`modules` above is) - just a
  // pointer back to the plan for display/reference.
  baseLicense?: mongoose.Types.ObjectId | IBaseParaClinicLicense;
  // When this license period started/expires (2026-09) - set from the
  // chosen price option's period (days) on purchase
  // (paraClinicController.purchaseLicense). `expiresAt` unset means the
  // license never expires (a hand-assigned license, or a pre-2026-09
  // record) - see resolveMyLicenseModules, which treats an expired
  // license the same as no license at all.
  startedAt?: Date;
  expiresAt?: Date;
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
    baseLicense: {
      type: mongoose.Schema.ObjectId,
      ref: "BaseParaClinicLicense",
    },
    startedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const ParaClinicProfileLicense = mongoose.model(
  "ParaClinicProfileLicense",
  ParaClinicProfileLicenseSchema,
);

export default ParaClinicProfileLicense;
