import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// What each imported record became (2026-10, bulk provider import): the
// source's own id (externalId) of a doctor, office, centre or insurer ->
// our record. A second run of the same file finds the same records through
// it, so nothing is duplicated. The private phones of the source (never
// shown on the site) are kept here for the staff, e.g. to invite the
// provider to claim the page.
export const providerImportLinkKinds = ["doctor", "office", "clinic", "hospital", "pharmacy", "lab", "insurer"] as const;
export type ProviderImportLinkKind = (typeof providerImportLinkKinds)[number];

// where the record came from (a partner's file): kept for traceability and
// attribution, never shown on the site
export type ProviderImportSource = {
  key: string;
  contractRef?: string;
  generatedAt?: string;
  url?: string;
  photoUrl?: string;
};

export interface IProviderImportLink extends MongoDoc {
  kind: ProviderImportLinkKind;
  externalId: string;
  target: mongoose.Types.ObjectId;
  privatePhones: string[];
  source?: ProviderImportSource;
  lastImport?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ProviderImportLinkSchema = new mongoose.Schema<IProviderImportLink, Model<IProviderImportLink>>(
  {
    kind: { type: String, enum: providerImportLinkKinds, required: true },
    externalId: { type: String, required: true, maxlength: 200 },
    target: { type: mongoose.Schema.ObjectId, required: true, index: true },
    privatePhones: { type: [String], default: [] },
    source: {
      key: { type: String, maxlength: 40 },
      contractRef: { type: String, maxlength: 120 },
      generatedAt: { type: String, maxlength: 60 },
      url: { type: String, maxlength: 600 },
      photoUrl: { type: String, maxlength: 1200 },
    },
    lastImport: { type: mongoose.Schema.ObjectId, ref: "ProviderImport" },
  },
  { timestamps: true },
);

ProviderImportLinkSchema.index({ kind: 1, externalId: 1 }, { unique: true });

const ProviderImportLink = mongoose.model("ProviderImportLink", ProviderImportLinkSchema);

export default ProviderImportLink;
