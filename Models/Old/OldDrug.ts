import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";

export interface IOldDrug extends MongoDoc {
  name: string;
  summary?: string;
  description?: string;
  sideEffects?: string;
  activeIngridient?: string;
  adminstrationRoute?: string;
  alcoholWarning?: string;
  alternateName?: string;
  breastfeedingWarning?: string;
  clinicalPharmacology?: string;
  dosageForm?: string;
  drugUnit?: string;
  foodWarning?: string;
  identifier?: string;
  image?: string;
  overdosage?: string;
  pregnancyWarning?: string;
  prescribingInfo?: string;
  prescriptionStatus?: string;
  warning?: string;
  order: number;
}

const drugSchema = new mongoose.Schema<IOldDrug, Model<IOldDrug>>({
  name: { type: String, required: true, unique: true, trim: true },
  summary: { type: String },
  description: { type: String, trim: true },
  sideEffects: { type: String, trim: true },
  activeIngridient: { type: String, trim: true },
  adminstrationRoute: { type: String, trim: true },
  alcoholWarning: { type: String, trim: true },
  alternateName: { type: String, trim: true },
  breastfeedingWarning: { type: String, trim: true },
  clinicalPharmacology: { type: String, trim: true },
  dosageForm: { type: String, trim: true },
  drugUnit: { type: String, trim: true },
  foodWarning: { type: String, trim: true },
  identifier: { type: String, trim: true },
  image: { type: String },
  overdosage: { type: String, trim: true },
  pregnancyWarning: { type: String, trim: true },
  prescribingInfo: { type: String, trim: true },
  prescriptionStatus: { type: String, trim: true },
  warning: { type: String, trim: true },
  order: { type: Number, default: 0 },
});

const OldDrug = mongoose.connection.useDb("Noyan").model("Drug", drugSchema);

export default OldDrug;
