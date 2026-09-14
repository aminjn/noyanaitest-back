import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";

// Per-pharmacy tax settings (2026-09) - one document per pharmacy
// (unique-indexed on `pharmacy`), since different pharmacies can be given
// different tax rates on what they sell (ProductSeller/ProductPackage items,
// see Controllers/cartController.ts submitCart). Admin-managed via
// Routers/autoRouter.ts (full CRUD, not a singleton - contrast with
// Models/GlobalTaxSettings.ts). A pharmacy with no doc here yet should fall
// back to GlobalTaxSettings.defaultPharmacyTaxPercent - see
// Lib/taxSettings.ts. Modeled directly on Models/PharmacyFinanceSettings.ts.
// Sibling settings: Models/DoctorTaxSettings.ts, Models/ClinicTaxSettings.ts,
// Models/ParaClinicTaxSettings.ts.
export interface IPharmacyTaxSettings extends MongoDoc {
  pharmacy: IPharmacy;

  // Tax charged on top of this pharmacy's item prices at checkout, as a
  // percent (0-100). Added to the buyer's total - never changes the
  // displayed item price itself (2026-09 user decision).
  taxPercent: number;
}

const PharmacyTaxSettingsSchema = new mongoose.Schema<
  IPharmacyTaxSettings,
  Model<IPharmacyTaxSettings>
>({
  pharmacy: {
    type: mongoose.Schema.ObjectId,
    ref: "Pharmacy",
    required: true,
    unique: true,
  },
  taxPercent: { type: Number, required: true, min: 0, max: 100 },
});

const PharmacyTaxSettings = mongoose.model(
  "PharmacyTaxSettings",
  PharmacyTaxSettingsSchema,
);

export default PharmacyTaxSettings;
