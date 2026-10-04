import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A cost-estimate request (2026-10, Nexxa EstimateRequest): someone asks
// what a treatment would cost, from the public form (/r/<slug>) or typed
// in by the desk; reviewed, then turned once into a treatment inquiry
// (BizLead) - with the patient matched by phone or added.
export interface IBizInquiry extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  subject: string;
  description?: string;
  kind?: string;
  // a lab's home-sampling request: where and when, and who referred
  address?: string;
  preferredAt?: string;
  referrerName?: string;
  budget: number;
  status: "new" | "reviewed" | "converted" | "closed";
  source: "web" | "manual";
  lead?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizInquirySchema = new mongoose.Schema<IBizInquiry, Model<IBizInquiry>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    company: { type: String, trim: true, maxlength: 120 },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    kind: { type: String, maxlength: 20 },
    address: { type: String, trim: true, maxlength: 500 },
    preferredAt: { type: String, trim: true, maxlength: 120 },
    referrerName: { type: String, trim: true, maxlength: 120 },
    budget: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["new", "reviewed", "converted", "closed"], default: "new" },
    source: { type: String, enum: ["web", "manual"], default: "manual" },
    lead: { type: mongoose.Schema.ObjectId, ref: "BizLead" },
  },
  { timestamps: true },
);

BizInquirySchema.index({ ownerKind: 1, ownerId: 1, status: 1, createdAt: -1 });

const BizInquiry = mongoose.model("BizInquiry", BizInquirySchema);
export default BizInquiry;
