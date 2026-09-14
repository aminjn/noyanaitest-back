import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";

// Per-paraClinic tax settings (2026-09) - one document per paraClinic
// (unique-indexed on `paraClinic`), since different paraClinics can be
// given different tax rates on the tests they sell (ParaClinicTest items,
// see Controllers/cartController.ts submitCart). Admin-managed via
// Routers/autoRouter.ts (full CRUD, not a singleton - contrast with
// Models/GlobalTaxSettings.ts). A paraClinic with no doc here yet should
// fall back to GlobalTaxSettings.defaultParaClinicTaxPercent - see
// Lib/taxSettings.ts. Modeled directly on
// Models/ParaClinicFinanceSettings.ts. Sibling settings:
// Models/PharmacyTaxSettings.ts, Models/DoctorTaxSettings.ts,
// Models/ClinicTaxSettings.ts.
export interface IParaClinicTaxSettings extends MongoDoc {
  paraClinic: IParaClinic;

  // Tax charged on top of this paraClinic's test prices at checkout, as a
  // percent (0-100). Added to the buyer's total - never changes the
  // displayed item price itself (2026-09 user decision).
  taxPercent: number;
}

const ParaClinicTaxSettingsSchema = new mongoose.Schema<
  IParaClinicTaxSettings,
  Model<IParaClinicTaxSettings>
>({
  paraClinic: {
    type: mongoose.Schema.ObjectId,
    ref: "ParaClinic",
    required: true,
    unique: true,
  },
  taxPercent: { type: Number, required: true, min: 0, max: 100 },
});

const ParaClinicTaxSettings = mongoose.model(
  "ParaClinicTaxSettings",
  ParaClinicTaxSettingsSchema,
);

export default ParaClinicTaxSettings;
