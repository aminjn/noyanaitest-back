import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  IMedicalContentFields,
  medicalContentFields,
  medicalReviewPlugin,
} from "../Lib/medicalContent";
import { IDrugTag } from "./Drugtag";

// Whether a drug may be sold without a prescription (2026-10). Was free
// text; existing values are mapped once by Lib/migrateDrugPrescriptionStatus.
// otc -> over the counter; rx -> needs a prescription. Products linked to an
// "rx" drug require a prescription at checkout (Models/Product.ts).
export const drugPrescriptionStatuses = ["otc", "rx"] as const;
export type DrugPrescriptionStatus = (typeof drugPrescriptionStatuses)[number];

export interface IDrug extends MongoDoc, IMedicalContentFields {
  name?: string;
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
  prescriptionStatus?: DrugPrescriptionStatus;
  warning?: string;
  order: number;
  sameAs: IDrug[];
  slug?: string;
  old: mongoose.Types.ObjectId;
  brand?: string;
  tag?: IDrugTag;
  dosage?: string;
  aiSummary?: string;
  content: String;
  averageScore: number;
  commentCount: number;
}

const DrugSchema = new mongoose.Schema<IDrug, Model<IDrug>>({
  name: { type: String, trim: true, required: true },
  summary: { type: String },
  description: { type: String },
  sideEffects: { type: String },
  activeIngridient: { type: String },
  adminstrationRoute: { type: String },
  alcoholWarning: { type: String },
  alternateName: { type: String },
  breastfeedingWarning: { type: String },
  clinicalPharmacology: { type: String },
  dosageForm: { type: String },
  drugUnit: { type: String },
  foodWarning: { type: String },
  identifier: { type: String },
  image: { type: String },
  overdosage: { type: String },
  pregnancyWarning: { type: String },
  prescribingInfo: { type: String },
  prescriptionStatus: {
    type: String,
    enum: drugPrescriptionStatuses,
    // the admin form sends "" for "not set"
    set: (v: unknown) => (v === "" ? undefined : v),
  },
  warning: { type: String },
  order: { type: Number, default: 0 },
  sameAs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Drug" }],
    default: [],
  },
  slug: { type: String, unique: true, sparse: true },
  old: { type: mongoose.Schema.ObjectId },
  brand: { type: String },
  tag: { type: mongoose.Schema.ObjectId, ref: "DrugTag" },
  dosage: { type: String },
  aiSummary: { type: String },
  content: { type: String },
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  ...medicalContentFields,
});

DrugSchema.plugin(translatable);
DrugSchema.plugin(medicalReviewPlugin);

const Drug = mongoose.model("Drug", DrugSchema);

export default Drug;
