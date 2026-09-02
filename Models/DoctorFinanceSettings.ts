import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

// Per-doctor commission settings (2026-08) - one document per doctor
// (unique-indexed on `doctor`), since different doctors can be given
// different commission rates. Admin-managed via Routers/autoRouter.ts
// (full CRUD, not a singleton - contrast with
// Models/GlobalFinanceSettings.ts). A doctor with no doc here yet should
// fall back to GlobalFinanceSettings.defaultDoctorCommissionPercent - see
// that model's comment. Sibling settings: Models/PharmacyFinanceSettings.ts,
// Models/ParaClinicFinanceSettings.ts.
export interface IDoctorFinanceSettings extends MongoDoc {
  doctor: IDoctorProfile;

  // Commission the platform takes on this doctor's orders, as a percent
  // (0-100).
  commissionPercent: number;
}

const DoctorFinanceSettingsSchema = new mongoose.Schema<
  IDoctorFinanceSettings,
  Model<IDoctorFinanceSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  commissionPercent: { type: Number, required: true, min: 0, max: 100 },
});

const DoctorFinanceSettings = mongoose.model(
  "DoctorFinanceSettings",
  DoctorFinanceSettingsSchema,
);

export default DoctorFinanceSettings;
