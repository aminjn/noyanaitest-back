import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";
import { IBizLineRef, LineRefSchema } from "./BizLead";

// A treatment plan / estimate (2026-10, Lib/business/crmSales.ts; Nexxa
// Proposal + ProposalItem, and the proforma with its approval): lines from
// the provider's own services, packages or stock items, sent to the patient
// by SMS (/tp/<token>), accepted with a drawn signature, turned once into a
// finance invoice (Lib/business/invoices.ts). A plan above the approval
// threshold waits for the centre manager before it may be sent.
export const bizPlanStatuses = ["draft", "sent", "accepted", "declined", "revised"] as const;

export interface IBizPlanItem {
  _id: mongoose.Types.ObjectId;
  title: string;
  ref?: IBizLineRef;
  qty: number;
  unitPrice: number;
  // percent
  discount: number;
  taxRate: number;
  // sessions of this line (a course of laser, a physio series)
  sessions?: number;
}

export interface IBizPlan extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  subject: string;
  contact?: mongoose.Types.ObjectId;
  lead?: mongoose.Types.ObjectId;
  doctorName?: string;
  referrerName?: string;
  date: Date;
  openTill?: Date;
  status: (typeof bizPlanStatuses)[number];
  discountPercent: number;
  items: IBizPlanItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  note?: string;
  terms?: string;
  invoice?: mongoose.Types.ObjectId;
  token: string;
  sentAt?: Date;
  decidedAt?: Date;
  acceptedName?: string;
  acceptedIp?: string;
  signature?: string;
  approval: { status: "none" | "pending" | "approved" | "rejected"; request?: mongoose.Types.ObjectId };
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema = new mongoose.Schema<IBizPlanItem>({
  title: { type: String, required: true, trim: true, maxlength: 300 },
  ref: { type: LineRefSchema, default: undefined },
  qty: { type: Number, default: 1, min: 0 },
  unitPrice: { type: Number, default: 0, min: 0 },
  discount: { type: Number, default: 0, min: 0, max: 100 },
  taxRate: { type: Number, default: 0, min: 0, max: 50 },
  sessions: { type: Number, min: 0, max: 1000 },
});

const BizPlanSchema = new mongoose.Schema<IBizPlan, Model<IBizPlan>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    lead: { type: mongoose.Schema.ObjectId, ref: "BizLead" },
    doctorName: { type: String, trim: true, maxlength: 120 },
    referrerName: { type: String, trim: true, maxlength: 120 },
    date: { type: Date, default: () => new Date() },
    openTill: Date,
    status: { type: String, enum: bizPlanStatuses, default: "draft" },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    items: { type: [ItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    note: { type: String, trim: true, maxlength: 2000 },
    terms: { type: String, trim: true, maxlength: 5000 },
    invoice: { type: mongoose.Schema.ObjectId, ref: "BizInvoice" },
    token: { type: String, required: true, unique: true },
    sentAt: Date,
    decidedAt: Date,
    acceptedName: { type: String, trim: true, maxlength: 120 },
    acceptedIp: { type: String, maxlength: 60 },
    signature: { type: String, maxlength: 420_000 },
    approval: {
      status: { type: String, enum: ["none", "pending", "approved", "rejected"], default: "none" },
      request: { type: mongoose.Schema.ObjectId, ref: "BizRequest" },
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizPlanSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizPlanSchema.index({ ownerKind: 1, ownerId: 1, status: 1, date: -1 });
BizPlanSchema.index({ ownerKind: 1, ownerId: 1, contact: 1 });

const BizPlan = mongoose.model("BizPlan", BizPlanSchema);
export default BizPlan;
