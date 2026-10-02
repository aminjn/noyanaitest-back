import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One accounting voucher (سند) of one owner's books (Lib/business/voucher.ts).
// Always balanced. Automatic vouchers carry a ref (e.g. "tx:<id>") that is
// unique per owner, so posting the same event twice is a no-op; they are
// never edited or deleted by hand.
export const bizVoucherKinds = ["auto", "manual", "opening", "closing"] as const;

export interface IBizVoucherLine {
  account: mongoose.Types.ObjectId;
  // the account's code, kept with the line so reports need no join
  code: string;
  label?: string;
  debit: number;
  credit: number;
}

export interface IBizVoucher extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  number: number;
  date: Date;
  kind: (typeof bizVoucherKinds)[number];
  ref?: string;
  description: string;
  // what it came from, for the link back (reservation, order, withdrawal...)
  source?: { type: string; id: mongoose.Types.ObjectId };
  lines: IBizVoucherLine[];
  total: number;
  createdBy?: IUser;
  createdAt: Date;
}

const LineSchema = new mongoose.Schema<IBizVoucherLine>(
  {
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
    code: { type: String, required: true },
    label: { type: String, maxlength: 300 },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const SourceSchema = new mongoose.Schema(
  { type: { type: String }, id: { type: mongoose.Schema.ObjectId } },
  { _id: false },
);

const BizVoucherSchema = new mongoose.Schema<IBizVoucher, Model<IBizVoucher>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    number: { type: Number, required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: bizVoucherKinds, default: "auto" },
    ref: { type: String },
    description: { type: String, maxlength: 500, default: "" },
    source: { type: SourceSchema, default: undefined },
    lines: { type: [LineSchema], validate: (v: unknown[]) => Array.isArray(v) && v.length >= 2 },
    total: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizVoucherSchema.index(
  { ownerKind: 1, ownerId: 1, ref: 1 },
  { unique: true, partialFilterExpression: { ref: { $type: "string" } } },
);
BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, "lines.account": 1, date: 1 });

const BizVoucher = mongoose.model("BizVoucher", BizVoucherSchema);

export default BizVoucher;
