import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A patient invoice (صورتحساب) of one provider (2026-10, Lib/business/
// invoices.ts). Two origins:
//   platform - written by Noyan from a paid visit or order (one per visit,
//              one per order); already paid through the wallet and already
//              in the books (Lib/business/ledgerPoster.ts), so it never
//              posts a voucher of its own
//   manual   - typed by the provider for an in-person visit, a procedure,
//              a sale at the counter: issuing it books the receivable and
//              the income, payments clear it
// Amounts are in toman. The insurer's share (Tamin, Salamat, armed forces,
// a supplementary insurer) is booked to «مطالبات از بیمه‌ها» and collected
// through an insurance claim (BizClaim), the patient's share through
// payments (BizPayment).
export const bizInvoiceStatuses = ["draft", "issued", "partial", "paid", "void"] as const;
export type BizInvoiceStatus = (typeof bizInvoiceStatuses)[number];
export const bizInsurerKinds = ["tamin", "salamat", "armed", "supplementary", "other"] as const;
export type BizInsurerKind = (typeof bizInsurerKinds)[number];

export interface IBizInvoiceLine {
  title: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxRate: number;
  // the income account it is booked to
  account?: mongoose.Types.ObjectId;
  // qty × unitPrice − discount (before tax)
  net: number;
  tax: number;
  // a platform invoice's line: the transaction it came from
  tx?: mongoose.Types.ObjectId;
  // (2026-10) a stock item sold on a manual invoice (the pharmacy counter):
  // issuing takes it out of stock by FEFO and books its cost of sales,
  // voiding brings the same batches back
  item?: mongoose.Types.ObjectId;
}

export interface IBizInvoice extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  origin: "platform" | "manual";
  ref?: string;
  date: Date;
  dueDate?: Date;
  party: { name: string; phone?: string; nationalId?: string };
  // the doctor who gave the service (a clinic's or hospital's invoice)
  doctorName?: string;
  lines: IBizInvoiceLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  insurer?: { kind: BizInsurerKind; name: string; share: number };
  // total − the insurer's share
  patientShare: number;
  // what the patient paid (cheques not bounced included)
  paid: number;
  status: BizInvoiceStatus;
  note?: string;
  issuedAt?: Date;
  voidedAt?: Date;
  voidReason?: string;
  // the public link sent by SMS (/i/<token>)
  token: string;
  smsSentAt?: Date;
  claim?: mongoose.Types.ObjectId;
  moadian?: mongoose.Types.ObjectId;
  center?: mongoose.Types.ObjectId;
  source?: { type: string; id: mongoose.Types.ObjectId };
  createdBy?: mongoose.Types.ObjectId;
  // a pre-invoice (پیش‌فاکتور, 2026-10 Lib/business/accExtras.ts): books
  // nothing, has its own P-number, becomes an invoice when converted
  proforma?: boolean;
  proformaNumber?: number;
  convertedAt?: Date;
  createdAt: Date;
}

const LineSchema = new mongoose.Schema<IBizInvoiceLine>(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    qty: { type: Number, default: 1, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    net: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    tx: { type: mongoose.Schema.ObjectId },
    item: { type: mongoose.Schema.ObjectId, ref: "BizItem" },
  },
  { _id: false },
);

const BizInvoiceSchema = new mongoose.Schema<IBizInvoice, Model<IBizInvoice>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    origin: { type: String, enum: ["platform", "manual"], default: "manual" },
    ref: { type: String },
    date: { type: Date, required: true },
    dueDate: { type: Date },
    party: {
      name: { type: String, trim: true, maxlength: 200, default: "" },
      phone: { type: String, trim: true, maxlength: 30 },
      nationalId: { type: String, trim: true, maxlength: 20 },
    },
    doctorName: { type: String, trim: true, maxlength: 200 },
    lines: { type: [LineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    insurer: {
      type: new mongoose.Schema(
        {
          kind: { type: String, enum: bizInsurerKinds, default: "other" },
          name: { type: String, trim: true, maxlength: 120 },
          share: { type: Number, default: 0, min: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    patientShare: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    status: { type: String, enum: bizInvoiceStatuses, default: "draft" },
    note: { type: String, trim: true, maxlength: 1000 },
    issuedAt: { type: Date },
    voidedAt: { type: Date },
    voidReason: { type: String, trim: true, maxlength: 500 },
    token: { type: String, required: true },
    smsSentAt: { type: Date },
    claim: { type: mongoose.Schema.ObjectId, ref: "BizClaim" },
    moadian: { type: mongoose.Schema.ObjectId, ref: "MoadianInvoice" },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    source: { type: new mongoose.Schema({ type: String, id: mongoose.Schema.ObjectId }, { _id: false }), default: undefined },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    proforma: { type: Boolean },
    proformaNumber: { type: Number },
    convertedAt: { type: Date },
  },
  { timestamps: true },
);

BizInvoiceSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizInvoiceSchema.index({ ownerKind: 1, ownerId: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: "string" } } });
BizInvoiceSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizInvoiceSchema.index({ token: 1 }, { unique: true });

const BizInvoice = mongoose.model("BizInvoice", BizInvoiceSchema);
export default BizInvoice;
