import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";

// Per-pharmacy commission settings (2026-08) - one document per pharmacy
// (unique-indexed on `pharmacy`), since different pharmacies can be given
// different commission rates. Admin-managed via Routers/autoRouter.ts
// (full CRUD, not a singleton - contrast with
// Models/GlobalFinanceSettings.ts). A pharmacy with no doc here yet should
// fall back to GlobalFinanceSettings.defaultPharmacyCommissionPercent - see
// that model's comment. Sibling settings: Models/DoctorFinanceSettings.ts,
// Models/ParaClinicFinanceSettings.ts.
export interface IPharmacyFinanceSettings extends MongoDoc {
  pharmacy: IPharmacy;

  // Commission the platform takes on this pharmacy's orders, as a percent
  // (0-100).
  commissionPercent: number;
}

const PharmacyFinanceSettingsSchema = new mongoose.Schema<
  IPharmacyFinanceSettings,
  Model<IPharmacyFinanceSettings>
>({
  pharmacy: {
    type: mongoose.Schema.ObjectId,
    ref: "Pharmacy",
    required: true,
    unique: true,
  },
  commissionPercent: { type: Number, required: true, min: 0, max: 100 },
});

const PharmacyFinanceSettings = mongoose.model(
  "PharmacyFinanceSettings",
  PharmacyFinanceSettingsSchema,
);

export default PharmacyFinanceSettings;
