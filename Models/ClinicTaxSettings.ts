import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";

// Per-clinic tax settings (2026-09) - one document per clinic
// (unique-indexed on `clinic`), same shape as
// Models/PharmacyTaxSettings.ts/Models/ParaClinicTaxSettings.ts. A clinic
// with no doc here yet should fall back to
// GlobalTaxSettings.defaultClinicTaxPercent - see Lib/taxSettings.ts.
//
// Note: unlike Pharmacy (ProductSeller/ProductPackage checkout) and
// ParaClinic (test checkout), Clinic currently owns no sellable/payable
// item or flow in this codebase - Models/Order.ts's orderModels has no
// clinic-owned model, and Models/Clinic.ts has no price field (see
// Models/Order.ts's orderSmsEvents comment: "Nothing a Clinic owns can
// appear as an order item today"). This model + its admin tab exist for
// parity (2026-09 user decision - "include Clinic too"), but there is
// nothing yet to actually apply this rate to; it's scaffolding, not wired
// into any checkout/payment flow.
export interface IClinicTaxSettings extends MongoDoc {
  clinic: IClinic;

  taxPercent: number;
}

const ClinicTaxSettingsSchema = new mongoose.Schema<
  IClinicTaxSettings,
  Model<IClinicTaxSettings>
>({
  clinic: {
    type: mongoose.Schema.ObjectId,
    ref: "Clinic",
    required: true,
    unique: true,
  },
  taxPercent: { type: Number, required: true, min: 0, max: 100 },
});

const ClinicTaxSettings = mongoose.model(
  "ClinicTaxSettings",
  ClinicTaxSettingsSchema,
);

export default ClinicTaxSettings;
