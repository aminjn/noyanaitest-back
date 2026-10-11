import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// A saved field mapping of the bulk provider import (2026-10): the next
// file from the same source reuses it instead of being mapped again.
export interface IProviderImportTemplate extends MongoDoc {
  name: string;
  mapping: Record<string, unknown>;
  createdBy?: IUser;
  createdAt: Date;
  updatedAt: Date;
}

const ProviderImportTemplateSchema = new mongoose.Schema<IProviderImportTemplate, Model<IProviderImportTemplate>>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, unique: true },
    mapping: { type: mongoose.Schema.Types.Mixed, required: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

const ProviderImportTemplate = mongoose.model("ProviderImportTemplate", ProviderImportTemplateSchema);

export default ProviderImportTemplate;
