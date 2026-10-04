import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A care plan or membership (2026-10, Nexxa Subscription): monthly
// physiotherapy, a diabetes follow-up programme, a yearly membership, an
// insurer's premium in instalments. Each period it makes one finance
// invoice (Lib/business/invoices.ts), issued at once when autoIssue. The
// period is claimed atomically (nextRunDate moves on in the same update),
// so the job, the button and a double click never bill it twice.
export interface IBizCarePlan extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  contact: mongoose.Types.ObjectId;
  name: string;
  amount: number;
  taxRate: number;
  interval: "week" | "month" | "year";
  intervalCount: number;
  startDate: Date;
  nextRunDate: Date;
  endDate?: Date;
  status: "active" | "paused" | "canceled";
  autoIssue: boolean;
  lastRunAt?: Date;
  generatedCount: number;
  invoices: mongoose.Types.ObjectId[];
  note?: string;
  lastError?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizCarePlanSchema = new mongoose.Schema<IBizCarePlan, Model<IBizCarePlan>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact", required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    amount: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 50 },
    interval: { type: String, enum: ["week", "month", "year"], default: "month" },
    intervalCount: { type: Number, default: 1, min: 1, max: 36 },
    startDate: { type: Date, required: true },
    nextRunDate: { type: Date, required: true },
    endDate: Date,
    status: { type: String, enum: ["active", "paused", "canceled"], default: "active" },
    autoIssue: { type: Boolean, default: false },
    lastRunAt: Date,
    generatedCount: { type: Number, default: 0 },
    invoices: { type: [{ type: mongoose.Schema.ObjectId, ref: "BizInvoice" }], default: [] },
    note: { type: String, trim: true, maxlength: 1000 },
    lastError: { type: String, maxlength: 300 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizCarePlanSchema.index({ ownerKind: 1, ownerId: 1, status: 1 });
BizCarePlanSchema.index({ status: 1, nextRunDate: 1 });

const BizCarePlan = mongoose.model("BizCarePlan", BizCarePlanSchema);
export default BizCarePlan;
