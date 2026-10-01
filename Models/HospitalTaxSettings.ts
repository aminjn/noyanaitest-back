import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IHospital } from "./Hospital";

// Per-hospital tax settings (2026-10 admin audit P2-10) - one document per
// hospital (unique-indexed on `hospital`), same shape as
// Models/ClinicTaxSettings.ts. Applied to in-person visits held in an office
// inside this hospital, in place of the doctor's own visit rate (the
// hospital is the place of service - Lib/taxSettings.ts getVisitTaxPercent).
// Unlike the clinic there is no platform-wide hospital default: a hospital
// with no doc here keeps the doctor's visit rate, so adding this setting
// changed no existing price.
export interface IHospitalTaxSettings extends MongoDoc {
  hospital: IHospital;

  taxPercent: number;
}

const HospitalTaxSettingsSchema = new mongoose.Schema<
  IHospitalTaxSettings,
  Model<IHospitalTaxSettings>
>({
  hospital: {
    type: mongoose.Schema.ObjectId,
    ref: "Hospital",
    required: true,
    unique: true,
  },
  taxPercent: { type: Number, required: true, min: 0, max: 100 },
});

const HospitalTaxSettings = mongoose.model(
  "HospitalTaxSettings",
  HospitalTaxSettingsSchema,
);

export default HospitalTaxSettings;
