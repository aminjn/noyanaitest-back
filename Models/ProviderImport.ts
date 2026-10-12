import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// One bulk provider import (2026-10, Services/providerImport.ts): the file
// the super admin uploaded (kept in NotPublic/imports/<id>.json until the
// run is over), the mapping it ran with, the dry run's and the run's
// reports, and the progress the panel polls. The list of these is the
// import history.

export const providerImportStatuses = ["uploaded", "validating", "validated", "applying", "done", "failed"] as const;
export type ProviderImportStatus = (typeof providerImportStatuses)[number];

export interface IProviderImport extends MongoDoc {
  fileName: string;
  size: number;
  status: ProviderImportStatus;
  createdBy?: IUser;
  native: boolean;
  // the mapping the last dry run / run used (Lib/providerImport/mapping.ts)
  mapping?: Record<string, unknown>;
  template?: string;
  // the partner file's own facts (Lib/providerImport/partners.ts)
  partner?: { key?: string; contractRef?: string; generatedAt?: string; detectedTemplate?: string };
  fileDeleted: boolean;
  progress: { phase: string; processed: number; total: number };
  validation?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProviderImportSchema = new mongoose.Schema<IProviderImport, Model<IProviderImport>>(
  {
    fileName: { type: String, required: true, maxlength: 300 },
    size: { type: Number, default: 0 },
    status: { type: String, enum: providerImportStatuses, default: "uploaded", index: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    native: { type: Boolean, default: false },
    mapping: { type: mongoose.Schema.Types.Mixed },
    template: { type: String },
    partner: { type: mongoose.Schema.Types.Mixed },
    fileDeleted: { type: Boolean, default: false },
    progress: {
      phase: { type: String, default: "" },
      processed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    validation: { type: mongoose.Schema.Types.Mixed },
    report: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);

const ProviderImport = mongoose.model("ProviderImport", ProviderImportSchema);

export default ProviderImport;
