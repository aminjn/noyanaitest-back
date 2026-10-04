import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The CRM sales settings of one owner (2026-10, Lib/business/crmSales.ts):
// round-robin assignment (Nexxa crm.autoAssign), the approval chains of
// treatment plans, discounts and credit limits (Nexxa approval-chain), and
// the public inquiry form (Nexxa webform + estimate requests).
export interface IBizChain {
  enabled: boolean;
  approvers: mongoose.Types.ObjectId[];
  // plans: only from this total up (0 = all)
  minAmount: number;
}

export interface IBizCrmSettings extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  autoAssign: { enabled: boolean; users: mongoose.Types.ObjectId[] };
  // Nexxa leadScopeWhere: the panel owner sees every lead; a team manager
  // their own, their teams' and the unassigned; anyone else their own and
  // the unassigned. Off (a one-desk practice): everyone sees everything.
  teamScope: boolean;
  approvals: { plan: IBizChain; discount: IBizChain; credit: IBizChain };
  webform: {
    enabled: boolean;
    // the public address: /f/<slug> (lead) and /r/<slug> (estimate request)
    slug?: string;
    requests: boolean;
    pipeline?: mongoose.Types.ObjectId;
    title?: string;
    intro?: string;
    thanks?: string;
    askEmail: boolean;
    askCity: boolean;
    askKind: boolean;
  };
  createdAt: Date;
}

const chain = {
  enabled: { type: Boolean, default: false },
  approvers: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
  minAmount: { type: Number, default: 0, min: 0 },
};

const BizCrmSettingsSchema = new mongoose.Schema<IBizCrmSettings, Model<IBizCrmSettings>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    autoAssign: {
      enabled: { type: Boolean, default: false },
      users: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
    },
    teamScope: { type: Boolean, default: false },
    approvals: { plan: chain, discount: chain, credit: chain },
    webform: {
      enabled: { type: Boolean, default: false },
      slug: { type: String, trim: true, lowercase: true, maxlength: 40 },
      requests: { type: Boolean, default: false },
      pipeline: { type: mongoose.Schema.ObjectId, ref: "BizPipeline" },
      title: { type: String, trim: true, maxlength: 120 },
      intro: { type: String, trim: true, maxlength: 600 },
      thanks: { type: String, trim: true, maxlength: 300 },
      askEmail: { type: Boolean, default: false },
      askCity: { type: Boolean, default: true },
      askKind: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

BizCrmSettingsSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });
BizCrmSettingsSchema.index({ "webform.slug": 1 }, { unique: true, partialFilterExpression: { "webform.slug": { $type: "string" } } });

const BizCrmSettings = mongoose.model("BizCrmSettings", BizCrmSettingsSchema);
export default BizCrmSettings;
