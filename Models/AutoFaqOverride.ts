import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { translatable } from "../Lib/i18n/translatable";

// A provider's change to one automatically generated FAQ item (2026-10,
// Lib/autoFaq.ts). The questions themselves are not stored: they are built
// from the provider's live data on every request, so an item nobody touched
// follows the data (a new price, a new office, the next free slot). Only
// what the provider changed is kept here - the wording of the question or
// the answer, hiding it, its position - one row per (owner, key).
//
// `factsHash` is the fingerprint of the facts the item was built from when
// the provider wrote their own answer: when today's facts differ, the panel
// says "your data changed - update this answer?".
export const autoFaqOwnerTypes = ["doctor"] as const;
export type AutoFaqOwnerType = (typeof autoFaqOwnerTypes)[number];

export interface IAutoFaqOverride extends MongoDoc {
  ownerType: AutoFaqOwnerType;
  owner: mongoose.Types.ObjectId;
  key: string;
  customQuestion?: string;
  customAnswer?: string;
  hidden?: boolean;
  order?: number;
  factsHash?: string;
  updatedAt?: Date;
}

const AutoFaqOverrideSchema = new mongoose.Schema<IAutoFaqOverride, Model<IAutoFaqOverride>>(
  {
    ownerType: { type: String, enum: autoFaqOwnerTypes, required: true },
    owner: { type: mongoose.Schema.ObjectId, required: true },
    key: { type: String, required: true, trim: true, maxlength: 40 },
    customQuestion: { type: String, trim: true, maxlength: 300 },
    customAnswer: { type: String, trim: true, maxlength: 2000 },
    hidden: { type: Boolean, default: false },
    order: { type: Number },
    factsHash: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

AutoFaqOverrideSchema.index({ ownerType: 1, owner: 1, key: 1 }, { unique: true });

AutoFaqOverrideSchema.plugin(translatable);

const AutoFaqOverride = mongoose.model("AutoFaqOverride", AutoFaqOverrideSchema);

export default AutoFaqOverride;
