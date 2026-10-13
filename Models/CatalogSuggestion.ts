import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// A name an import could not match to the catalogue (2026-10): instead of
// creating a speciality / condition / service from free text (which filled
// the catalogue with thousands of variants), the name waits here for the
// admin («ادغام و پاک‌سازی» tab): map it to an existing entry (remembered as
// a synonym, so the next import matches it), create a new entry, or reject
// it (the next import skips it). One record per kind + normalised name.
export const catalogSuggestionKinds = ["speciality", "disease", "service"] as const;
export const catalogSuggestionStatuses = ["pending", "mapped", "created", "rejected"] as const;

export interface ICatalogSuggestion extends MongoDoc {
  kind: (typeof catalogSuggestionKinds)[number];
  key: string;
  raw: string;
  variants: string[];
  doctors: mongoose.Types.ObjectId[];
  doctorCount: number;
  // doctors left unpublished only because no speciality matched
  drafts: mongoose.Types.ObjectId[];
  hint?: mongoose.Types.ObjectId;
  hintName?: string;
  status: (typeof catalogSuggestionStatuses)[number];
  target?: mongoose.Types.ObjectId;
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  lastImport?: mongoose.Types.ObjectId;
}

const CatalogSuggestionSchema = new mongoose.Schema<ICatalogSuggestion, Model<ICatalogSuggestion>>(
  {
    kind: { type: String, enum: catalogSuggestionKinds, required: true },
    key: { type: String, required: true },
    raw: { type: String, required: true, trim: true },
    variants: { type: [String], default: [] },
    doctors: { type: [{ type: mongoose.Schema.ObjectId, ref: "DoctorProfile" }], default: [] },
    doctorCount: { type: Number, default: 0 },
    drafts: { type: [{ type: mongoose.Schema.ObjectId, ref: "DoctorProfile" }], default: [] },
    // no `ref`: the model depends on the kind (and a merge must not re-point it)
    hint: { type: mongoose.Schema.ObjectId },
    hintName: { type: String },
    status: { type: String, enum: catalogSuggestionStatuses, default: "pending", index: true },
    target: { type: mongoose.Schema.ObjectId },
    resolvedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
    lastImport: { type: mongoose.Schema.ObjectId, ref: "ProviderImport" },
  },
  { timestamps: true },
);

CatalogSuggestionSchema.index({ kind: 1, key: 1 }, { unique: true });

const CatalogSuggestion = mongoose.model("CatalogSuggestion", CatalogSuggestionSchema);

export default CatalogSuggestion;
