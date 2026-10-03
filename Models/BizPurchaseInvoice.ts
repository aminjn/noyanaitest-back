import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A purchase invoice a seller registered in the Moadian system with this
// owner as the buyer (2026-10, Lib/business/purchaseInvoices.ts), brought in
// from the «صورتحساب‌های خرید» list of the taxpayer's کارپوشه. Each one is
// paired with what it was for:
//   open     - not paired yet
//   purchase - one received purchase of the books (stock bought)
//   expense  - booked from here as an expense (rent, repairs, services)
//   ignored  - not the owner's to book (a duplicate, a private purchase)
// Only a paired invoice that the buyer has not rejected makes its VAT
// creditable (Lib/business/vatReturn.ts). Amounts in toman; the portal's
// rials are divided by ten on import.
export const purchaseInvoiceMatches = ["open", "purchase", "expense", "ignored"] as const;
// 1 original, 2 correction, 3 cancellation, 4 return (as Moadian numbers them)
export const purchaseInvoiceSubjects = [1, 2, 3, 4] as const;

export interface IBizPurchaseInvoice extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  taxId: string;
  subject: (typeof purchaseInvoiceSubjects)[number];
  sellerName?: string;
  sellerCode?: string;
  issuedAt: Date;
  base: number;
  vat: number;
  total: number;
  // as the portal shows it: accepted, pending, rejected by the buyer...
  portalStatus?: string;
  rejected: boolean;
  match: (typeof purchaseInvoiceMatches)[number];
  purchase?: mongoose.Types.ObjectId;
  account?: mongoose.Types.ObjectId;
  // a booked expense: refs pinv:<id>:<seq> (and :rev when undone)
  seq: number;
  matchedAt?: Date;
  importedAt: Date;
  importedBy?: IUser;
}

const BizPurchaseInvoiceSchema = new mongoose.Schema<IBizPurchaseInvoice, Model<IBizPurchaseInvoice>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    taxId: { type: String, required: true, trim: true, maxlength: 40 },
    subject: { type: Number, enum: purchaseInvoiceSubjects, default: 1 },
    sellerName: { type: String, trim: true, maxlength: 200 },
    sellerCode: { type: String, trim: true, maxlength: 20 },
    issuedAt: { type: Date, required: true },
    base: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    portalStatus: { type: String, trim: true, maxlength: 60 },
    rejected: { type: Boolean, default: false },
    match: { type: String, enum: purchaseInvoiceMatches, default: "open" },
    purchase: { type: mongoose.Schema.ObjectId, ref: "BizPurchase" },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    seq: { type: Number, default: 0 },
    matchedAt: Date,
    importedAt: { type: Date, default: () => new Date() },
    importedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizPurchaseInvoiceSchema.index({ ownerKind: 1, ownerId: 1, taxId: 1 }, { unique: true });
BizPurchaseInvoiceSchema.index({ ownerKind: 1, ownerId: 1, issuedAt: -1 });
// a purchase is paired with one invoice at most
BizPurchaseInvoiceSchema.index({ ownerKind: 1, ownerId: 1, purchase: 1 }, { unique: true, partialFilterExpression: { purchase: { $exists: true } } });

const BizPurchaseInvoice = mongoose.model("BizPurchaseInvoice", BizPurchaseInvoiceSchema);
export default BizPurchaseInvoice;
