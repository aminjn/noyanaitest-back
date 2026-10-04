import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One centre-defined field on a patient or a treatment inquiry (2026-10,
// Nexxa CustomFieldDef): its key is made once from the label and never
// changes, so the saved values stay readable.
export interface IBizCustomField extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  entity: "contact" | "lead";
  label: string;
  key: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "checkbox";
  options: string[];
  required: boolean;
  sequence: number;
  active: boolean;
  // made from the profile's presets (crmProfiles.ts FIELD_PRESETS)
  preset?: string;
  createdAt: Date;
}

const BizCustomFieldSchema = new mongoose.Schema<IBizCustomField, Model<IBizCustomField>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    entity: { type: String, enum: ["contact", "lead"], required: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true, maxlength: 40 },
    type: { type: String, enum: ["text", "textarea", "number", "date", "select", "checkbox"], default: "text" },
    options: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
    required: { type: Boolean, default: false },
    sequence: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    preset: { type: String, maxlength: 30 },
  },
  { timestamps: true },
);

BizCustomFieldSchema.index({ ownerKind: 1, ownerId: 1, entity: 1, key: 1 }, { unique: true });

const BizCustomField = mongoose.model("BizCustomField", BizCustomFieldSchema);
export default BizCustomField;
