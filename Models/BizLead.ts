import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One treatment inquiry / sales opportunity (2026-10, Lib/business/
// crmSales.ts; Nexxa Lead + LeadItem): a patient's interest in a treatment
// (a cosmetic procedure, an implant, IVF, a surgery package, a company's
// staff check-up) moving through a pipeline's stages to accepted or lost.
// Its value is always the sum of its items.
export const bizLeadKinds = ["cosmetic", "dental", "ivf", "surgery", "checkup", "corporate", "medication", "lab", "imaging", "homeSampling", "supplementary", "group", "other"] as const;
export const bizLeadStatuses = ["open", "won", "lost"] as const;
// "insurancePlan": an insurer's own plan (Models/InsurancePlan.ts), what
// its corporate quotes and contracts sell per member (2026-10)
export const bizRefKinds = ["service", "package", "item", "insurancePlan"] as const;

export interface IBizLineRef {
  kind: (typeof bizRefKinds)[number];
  id: mongoose.Types.ObjectId;
}
export interface IBizLeadItem {
  _id: mongoose.Types.ObjectId;
  title: string;
  ref?: IBizLineRef;
  qty: number;
  unitPrice: number;
  // percent
  discount: number;
  sessions?: number;
}

export interface IBizLead extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  title: string;
  kind: (typeof bizLeadKinds)[number];
  contact?: mongoose.Types.ObjectId;
  pipeline: mongoose.Types.ObjectId;
  stage: mongoose.Types.ObjectId;
  status: (typeof bizLeadStatuses)[number];
  value: number;
  probability: number;
  priority: number;
  expectedClose?: Date;
  source?: mongoose.Types.ObjectId;
  sourceName?: string;
  assignee?: mongoose.Types.ObjectId;
  // a clinic's or hospital's treating doctor (per-doctor targets and
  // commission), and a lab's referring doctor (tracked only)
  doctor?: { id?: mongoose.Types.ObjectId; name: string };
  referrer?: mongoose.Types.ObjectId;
  referrerName?: string;
  note?: string;
  lostReason?: string;
  winReason?: string;
  closedAt?: Date;
  items: IBizLeadItem[];
  plan?: mongoose.Types.ObjectId;
  inquiry?: mongoose.Types.ObjectId;
  ruleScore: number;
  customFields?: Record<string, string>;
  lastActivityAt: Date;
  // stage moves and status changes (Nexxa's stage_change / status log)
  history: { at: Date; by?: mongoose.Types.ObjectId; kind: "created" | "stage" | "status" | "plan"; text: string }[];
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const LineRefSchema = new mongoose.Schema<IBizLineRef>(
  { kind: { type: String, enum: bizRefKinds, required: true }, id: { type: mongoose.Schema.ObjectId, required: true } },
  { _id: false },
);

const ItemSchema = new mongoose.Schema<IBizLeadItem>({
  title: { type: String, required: true, trim: true, maxlength: 300 },
  ref: { type: LineRefSchema, default: undefined },
  qty: { type: Number, default: 1, min: 0 },
  unitPrice: { type: Number, default: 0, min: 0 },
  discount: { type: Number, default: 0, min: 0, max: 100 },
  sessions: { type: Number, min: 0, max: 1000 },
});

const BizLeadSchema = new mongoose.Schema<IBizLead, Model<IBizLead>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    kind: { type: String, enum: bizLeadKinds, default: "other" },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    pipeline: { type: mongoose.Schema.ObjectId, ref: "BizPipeline", required: true },
    stage: { type: mongoose.Schema.ObjectId, required: true },
    status: { type: String, enum: bizLeadStatuses, default: "open" },
    value: { type: Number, default: 0, min: 0 },
    probability: { type: Number, default: 0, min: 0, max: 100 },
    priority: { type: Number, default: 0, min: 0, max: 3 },
    expectedClose: Date,
    source: { type: mongoose.Schema.ObjectId, ref: "BizLeadSource" },
    sourceName: { type: String, trim: true, maxlength: 80 },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    doctor: { type: new mongoose.Schema({ id: mongoose.Schema.ObjectId, name: { type: String, maxlength: 120 } }, { _id: false }), default: undefined },
    referrer: { type: mongoose.Schema.ObjectId, ref: "BizLeadSource" },
    referrerName: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 2000 },
    lostReason: { type: String, trim: true, maxlength: 300 },
    winReason: { type: String, trim: true, maxlength: 300 },
    closedAt: Date,
    items: { type: [ItemSchema], default: [] },
    plan: { type: mongoose.Schema.ObjectId, ref: "BizPlan" },
    inquiry: { type: mongoose.Schema.ObjectId, ref: "BizInquiry" },
    ruleScore: { type: Number, default: 0 },
    customFields: { type: mongoose.Schema.Types.Mixed, default: undefined },
    lastActivityAt: { type: Date, default: () => new Date() },
    history: {
      type: [new mongoose.Schema({ at: Date, by: mongoose.Schema.ObjectId, kind: String, text: { type: String, maxlength: 300 } }, { _id: false })],
      default: [],
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizLeadSchema.index({ ownerKind: 1, ownerId: 1, pipeline: 1, stage: 1, updatedAt: -1 });
BizLeadSchema.index({ ownerKind: 1, ownerId: 1, status: 1, assignee: 1 });
BizLeadSchema.index({ ownerKind: 1, ownerId: 1, contact: 1 });

const BizLead = mongoose.model("BizLead", BizLeadSchema);
export default BizLead;
