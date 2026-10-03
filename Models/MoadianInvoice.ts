import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One electronic invoice (صورتحساب الکترونیکی) of one taxpayer (2026-10,
// Lib/moadian/issue.ts). Amounts are in rials, as the Moadian API wants.
//   Queued   - made, waiting for the sender (or for a retry after an error)
//   Sent     - the tax organisation took it; its answer is awaited
//   Accepted - registered (the tax id is final)
//   Rejected - refused with errors; fix the settings or the buyer and retry
//   Dropped  - never sent (its sale was reversed before it went out, or it
//              was replaced before sending)
// subject (ins): 1 original, 2 correction, 3 cancellation, 4 return
// type (inty): 1 with the buyer's identity, 2 a final consumer's (no buyer)
export const moadianInvoiceStatuses = ["Queued", "Sent", "Accepted", "Rejected", "Dropped"] as const;
export type MoadianInvoiceStatus = (typeof moadianInvoiceStatuses)[number];
export const moadianSources = ["visit", "sale", "shipping", "reversal", "license", "sms", "commission", "manual"] as const;
export type MoadianSource = (typeof moadianSources)[number];

export interface IMoadianItem {
  kind: string;
  sstid: string;
  sstt: string;
  am: number;
  mu: string;
  fee: number;
  prdis: number;
  dis: number;
  adis: number;
  vra: number;
  vam: number;
  tsstam: number;
}

export interface IMoadianBuyer {
  type: "natural" | "legal";
  nationalId?: string;
  economicCode?: string;
  name?: string;
  postalCode?: string;
}

export interface IMoadianInvoice extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  source: MoadianSource;
  // the event it was made for, unique per owner ("tx:<id>", "sms:<id>",
  // "commission:<owner>:1405-07", ...)
  ref: string;
  transaction?: mongoose.Types.ObjectId;
  reservation?: mongoose.Types.ObjectId;
  order?: mongoose.Types.ObjectId;
  subject: 1 | 2 | 3 | 4;
  type: 1 | 2;
  // the invoice a correction, cancellation or return refers to
  of?: mongoose.Types.ObjectId;
  refTaxId?: string;
  replacedBy?: mongoose.Types.ObjectId;
  serial: number;
  taxId: string;
  issuedAt: Date;
  // who it was for, for the list (the patient, or the provider Noyan billed)
  party?: string;
  buyer?: IMoadianBuyer;
  items: IMoadianItem[];
  total: { tprdis: number; tdis: number; tadis: number; tvam: number; tbill: number };
  status: MoadianInvoiceStatus;
  referenceNumber?: string;
  uid?: string;
  taxErrors: { code?: string; message: string }[];
  taxWarnings: { code?: string; message: string }[];
  attempts: number;
  nextAttemptAt?: Date;
  sentAt?: Date;
  decidedAt?: Date;
  createdAt?: Date;
}

const issue = new mongoose.Schema({ code: String, message: String }, { _id: false });

const MoadianInvoiceSchema = new mongoose.Schema<IMoadianInvoice, Model<IMoadianInvoice>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    source: { type: String, enum: moadianSources, required: true },
    ref: { type: String, required: true },
    transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    order: { type: mongoose.Schema.ObjectId, ref: "Order" },
    subject: { type: Number, enum: [1, 2, 3, 4], default: 1 },
    type: { type: Number, enum: [1, 2], default: 2 },
    of: { type: mongoose.Schema.ObjectId, ref: "MoadianInvoice" },
    refTaxId: { type: String },
    replacedBy: { type: mongoose.Schema.ObjectId, ref: "MoadianInvoice" },
    serial: { type: Number, required: true },
    taxId: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    party: { type: String, maxlength: 200 },
    buyer: {
      type: {
        type: String,
        enum: ["natural", "legal"],
      },
      nationalId: String,
      economicCode: String,
      name: String,
      postalCode: String,
    },
    items: [
      {
        _id: false,
        kind: String,
        sstid: String,
        sstt: String,
        am: Number,
        mu: String,
        fee: Number,
        prdis: Number,
        dis: Number,
        adis: Number,
        vra: Number,
        vam: Number,
        tsstam: Number,
      },
    ],
    total: { tprdis: Number, tdis: Number, tadis: Number, tvam: Number, tbill: Number },
    status: { type: String, enum: moadianInvoiceStatuses, default: "Queued" },
    referenceNumber: { type: String },
    uid: { type: String },
    taxErrors: { type: [issue], default: [] },
    taxWarnings: { type: [issue], default: [] },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
    sentAt: { type: Date },
    decidedAt: { type: Date },
  },
  { timestamps: true },
);

MoadianInvoiceSchema.index({ ownerKind: 1, ownerId: 1, ref: 1 }, { unique: true });
MoadianInvoiceSchema.index({ ownerKind: 1, ownerId: 1, issuedAt: -1 });
MoadianInvoiceSchema.index({ status: 1, nextAttemptAt: 1 });
MoadianInvoiceSchema.index({ taxId: 1 }, { unique: true });

const MoadianInvoice = mongoose.model("MoadianInvoice", MoadianInvoiceSchema);

export default MoadianInvoice;
