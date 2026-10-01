import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";

// Per-clinic tax settings (2026-09) - one document per clinic
// (unique-indexed on `clinic`), same shape as
// Models/PharmacyTaxSettings.ts/Models/ParaClinicTaxSettings.ts. A clinic
// with no doc here yet should fall back to
// GlobalTaxSettings.defaultClinicTaxPercent - see Lib/taxSettings.ts.
//
// Applied to in-person visits held in an office inside this clinic, in
// place of the doctor's own visit rate (Lib/taxSettings.ts
// getVisitTaxPercent, Controllers/bookingController.ts).
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
