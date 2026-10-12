import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// The machine-translation queue of DB content (2026-10,
// Services/autoTranslate.ts): one row per record whose public text may lack
// a translation in an enabled site language. Rows are added when a
// translatable record is created or its Persian text changes
// (Lib/i18n/translatable.ts hooks) and by the backfill scan; the worker
// deletes a row once the record is translated (or no longer exists).
// Stored, not in memory, so a restart resumes where it stopped.
//   state     pending: waiting (or retrying at nextAt); failed: gave up
//             after MAX_ATTEMPTS - shown to the admin, retried by the
//             admin's backfill button
//   nextAt    not picked before this time (retry backoff, and a lease
//             while a worker is translating it)
export const translationTaskStates = ["pending", "failed"] as const;
export type TranslationTaskState = (typeof translationTaskStates)[number];

export interface ITranslationTask extends MongoDoc {
  model: string;
  doc: mongoose.Types.ObjectId;
  state: TranslationTaskState;
  attempts: number;
  nextAt: Date;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const TranslationTaskSchema = new mongoose.Schema<ITranslationTask, Model<ITranslationTask>>(
  {
    model: { type: String, required: true, maxlength: 80 },
    doc: { type: mongoose.Schema.ObjectId, required: true },
    state: { type: String, enum: translationTaskStates, default: "pending" },
    attempts: { type: Number, default: 0, min: 0 },
    nextAt: { type: Date, default: () => new Date() },
    lastError: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

TranslationTaskSchema.index({ model: 1, doc: 1 }, { unique: true });
TranslationTaskSchema.index({ state: 1, nextAt: 1 });

const TranslationTask = mongoose.model("TranslationTask", TranslationTaskSchema);

export default TranslationTask;
