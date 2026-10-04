import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Where a treatment inquiry came from (2026-10, Nexxa LeadSource):
// Instagram, a patient's referral, the website form, Noyan, ... and the
// standard reasons a patient decides against a treatment (Nexxa
// LossReason), both owner-managed lists. kind tells them apart.
export interface IBizLeadSource extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: "source" | "lossReason";
  name: string;
  active: boolean;
  sequence: number;
  // a built-in one (the web form's own source)
  system?: string;
  createdAt: Date;
}

const BizLeadSourceSchema = new mongoose.Schema<IBizLeadSource, Model<IBizLeadSource>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: ["source", "lossReason"], default: "source" },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    active: { type: Boolean, default: true },
    sequence: { type: Number, default: 0 },
    system: { type: String, maxlength: 30 },
  },
  { timestamps: true },
);

BizLeadSourceSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, name: 1 }, { unique: true });

const BizLeadSource = mongoose.model("BizLeadSource", BizLeadSourceSchema);
export default BizLeadSource;
