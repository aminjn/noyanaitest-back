import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";

// Per-paraClinic commission settings (2026-08) - one document per
// paraClinic (unique-indexed on `paraClinic`), since different paraClinics
// can be given different commission rates. Admin-managed via
// Routers/autoRouter.ts (full CRUD, not a singleton - contrast with
// Models/GlobalFinanceSettings.ts). A paraClinic with no doc here yet
// should fall back to
// GlobalFinanceSettings.defaultParaClinicCommissionPercent - see that
// model's comment. Sibling settings: Models/PharmacyFinanceSettings.ts,
// Models/DoctorFinanceSettings.ts.
export interface IParaClinicFinanceSettings extends MongoDoc {
  paraClinic: IParaClinic;

  // Commission the platform takes on this paraClinic's orders, as a percent
  // (0-100).
  // empty = the platform default (GlobalFinanceSettings)
  commissionPercent?: number | null;
}

const ParaClinicFinanceSettingsSchema = new mongoose.Schema<
  IParaClinicFinanceSettings,
  Model<IParaClinicFinanceSettings>
>({
  paraClinic: {
    type: mongoose.Schema.ObjectId,
    ref: "ParaClinic",
    required: true,
    unique: true,
  },
  commissionPercent: { type: Number, min: 0, max: 100 },
});

const ParaClinicFinanceSettings = mongoose.model(
  "ParaClinicFinanceSettings",
  ParaClinicFinanceSettingsSchema,
);

export default ParaClinicFinanceSettings;
