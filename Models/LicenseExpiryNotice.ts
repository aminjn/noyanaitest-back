import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One row per licence-expiry notice sent (Services/licenseExpiryService.ts):
// "7d" and "1d" before the end, and "expired". Unique per licence, stage and
// end date, so the hourly sweep sends each notice once, and a renewal (a new
// expiresAt) starts a fresh set. Kept apart from the six *ProfileLicense
// models so they need no reminder fields of their own.
// ("30d": a centre's operating licence, Services/centreLicenceService.ts -
// its rows have kind "centre:<kind>" and the centre's _id as `license`)
export const licenseExpiryStages = ["30d", "7d", "1d", "expired"] as const;
export type LicenseExpiryStage = (typeof licenseExpiryStages)[number];

export interface ILicenseExpiryNotice extends MongoDoc {
  license: mongoose.Types.ObjectId;
  // which licence model (doctor, clinic, ...)
  kind: string;
  stage: LicenseExpiryStage;
  expiresAt: Date;
  createdAt: Date;
}

const LicenseExpiryNoticeSchema = new mongoose.Schema<
  ILicenseExpiryNotice,
  Model<ILicenseExpiryNotice>
>({
  license: { type: mongoose.Schema.ObjectId, required: true },
  kind: { type: String, required: true },
  stage: { type: String, enum: licenseExpiryStages, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

LicenseExpiryNoticeSchema.index({ license: 1, stage: 1, expiresAt: 1 }, { unique: true });
// old rows are only an idempotency record
LicenseExpiryNoticeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

const LicenseExpiryNotice = mongoose.model("LicenseExpiryNotice", LicenseExpiryNoticeSchema);

export default LicenseExpiryNotice;
