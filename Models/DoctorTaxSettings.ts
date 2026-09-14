import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

// Per-doctor tax settings (2026-09) - one document per doctor
// (unique-indexed on `doctor`). Unlike Models/PharmacyTaxSettings.ts /
// Models/ParaClinicTaxSettings.ts (one sellable action each), a doctor has
// TWO independent sellable actions the user asked to tax separately: a
// booked visit/session (Controllers/bookingController.ts submitBookingNew -
// any DoctorSessionType: inPerson/sipCall/textChat/videoCall/voiceCall/
// phone) and a Service/ServicePackage sold through the cart
// (Controllers/cartController.ts submitCart's `services`/`servicePackages`
// lines). So both fields live on this one doc but are each OPTIONAL and
// fall back to their own GlobalTaxSettings default independently - a doctor
// can have a custom visit tax with no custom service tax, or vice versa.
// This is a deliberate divergence from Models/DoctorFinanceSettings.ts's
// single required field, since one field per sellable action needs its own
// "unset -> fall back to global" signal (see Lib/taxSettings.ts).
export interface IDoctorTaxSettings extends MongoDoc {
  doctor: IDoctorProfile;

  visitTaxPercent?: number;
  serviceTaxPercent?: number;
}

const DoctorTaxSettingsSchema = new mongoose.Schema<
  IDoctorTaxSettings,
  Model<IDoctorTaxSettings>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  visitTaxPercent: { type: Number, min: 0, max: 100 },
  serviceTaxPercent: { type: Number, min: 0, max: 100 },
});

const DoctorTaxSettings = mongoose.model(
  "DoctorTaxSettings",
  DoctorTaxSettingsSchema,
);

export default DoctorTaxSettings;
