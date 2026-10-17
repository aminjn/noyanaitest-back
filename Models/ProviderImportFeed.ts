import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// A contracted partner's live feed for the bulk provider import (2026-10,
// Services/providerImportFeed.ts): instead of the admin downloading the
// partner's JSON and uploading it, the server reads the feed itself - every
// `intervalHours`, or on «همگام‌سازی الان» - asking only for what changed
// since the last successful run (`since`), page by page (`limit` /
// `offset` / `next_offset`). Each run becomes an ordinary import (its row in
// the history, its report), mapped by the partner's built-in template.
// `url` holds the partner's key: it never leaves the server unmasked.
export interface IProviderImportFeed extends MongoDoc {
  name: string;
  url: string;
  enabled: boolean;
  // 0 = only on demand
  intervalHours: number;
  // the start of the last run whose import finished: the next run's `since`
  syncedUntil?: Date;
  syncing?: boolean;
  lastRun?: {
    at: Date;
    status: "done" | "empty" | "failed";
    records?: number;
    importId?: mongoose.Types.ObjectId;
    error?: string;
  };
  createdBy?: IUser;
  createdAt: Date;
  updatedAt: Date;
}

const ProviderImportFeedSchema = new mongoose.Schema<IProviderImportFeed, Model<IProviderImportFeed>>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    enabled: { type: Boolean, default: true },
    intervalHours: { type: Number, default: 24, min: 0, max: 24 * 30 },
    syncedUntil: { type: Date },
    syncing: { type: Boolean, default: false },
    lastRun: {
      at: { type: Date },
      status: { type: String, enum: ["done", "empty", "failed"] },
      records: { type: Number },
      importId: { type: mongoose.Schema.ObjectId, ref: "ProviderImport" },
      error: { type: String },
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

const ProviderImportFeed = mongoose.model("ProviderImportFeed", ProviderImportFeedSchema);

export default ProviderImportFeed;
