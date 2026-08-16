import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDrugTag } from "./Drugtag";

export interface IDrug extends MongoDoc {
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
  prescriptionStatus?: string;
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
  name: { type: String },
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
  prescriptionStatus: { type: String },
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
});

const Drug = mongoose.model("Drug", DrugSchema);

export default Drug;
