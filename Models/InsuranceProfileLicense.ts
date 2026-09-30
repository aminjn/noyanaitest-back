import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInsurance } from "./Insurance";
import {
  insuranceDashboardModules,
  InsuranceDashboardModule,
  IBaseInsuranceLicense,
} from "./BaseInsuranceLicense";

// The license currently assigned to an insurance profile (2026-09) - one
// document per insurance (unique-indexed on `owner`), tracking which
// dashboard modules that insurance currently has access to. Contrast with
// Models/BaseInsuranceLicense.ts, which is the admin-managed catalog of
// purchasable license tiers - `modules` here uses the same enum so a tier's
// modules can be copied onto an insurance's own license record. Mirrors
// Models/HospitalProfileLicense.ts.
export interface IInsuranceProfileLicense extends MongoDoc {
  owner: IInsurance;
  // Defaults to the purchased BaseInsuranceLicense's own displayName when an
  // insurance buys a license themselves (see
  // insuranceController.purchaseLicense), but an admin assigning/editing an
  // insurance's license by hand can freely override it with their own label.
  displayName?: string;
  modules: InsuranceDashboardModule[];
  // Reference to the BaseInsuranceLicense tier this record was purchased
  // from (2026-09) - unset for records created before this field existed, or
  // a hand-assigned license with no catalog tier behind it. Not authoritative
  // for access control (`modules` above is) - just a pointer back to the
  // plan for display/reference.
  baseLicense?: mongoose.Types.ObjectId | IBaseInsuranceLicense;
  // When this license period started/expires (2026-09) - set from the
  // chosen price option's period (days) on purchase
  // (insuranceController.purchaseLicense). `expiresAt` unset means the
  // license never expires (a hand-assigned license, or a pre-2026-09
  // record) - see resolveMyLicenseModules, which treats an expired license
  // the same as no license at all.
  startedAt?: Date;
  expiresAt?: Date;
}

const InsuranceProfileLicenseSchema = new mongoose.Schema<
  IInsuranceProfileLicense,
  Model<IInsuranceProfileLicense>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "Insurance",
      required: true,
      unique: true,
    },
    displayName: { type: String },
    modules: {
      type: [String],
      enum: insuranceDashboardModules,
      default: [],
    },
    baseLicense: {
      type: mongoose.Schema.ObjectId,
      ref: "BaseInsuranceLicense",
    },
    startedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const InsuranceProfileLicense = mongoose.model(
  "InsuranceProfileLicense",
  InsuranceProfileLicenseSchema,
);

export default InsuranceProfileLicense;
