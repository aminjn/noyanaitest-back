import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Treasury records that carry no voucher of their own (2026-10,
// Lib/business/treasury.ts, after Nexxa's BankStatementLine / Checkbook /
// trust Check / company accounting settings).

const own = {
  ownerKind: { type: String, enum: bizOwnerKinds, required: true },
  ownerId: { type: mongoose.Schema.ObjectId },
};

// one line of an imported bank statement and what it was matched to
export interface IBizBankLine extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  money: mongoose.Types.ObjectId;
  date: Date;
  // deposit +, withdrawal -
  amount: number;
  description?: string;
  reference?: string;
  balance?: number;
  status: "open" | "matched" | "ignored";
  voucher?: mongoose.Types.ObjectId;
  batch: string;
  hash: string;
  createdAt: Date;
}

const BizBankLineSchema = new mongoose.Schema<IBizBankLine, Model<IBizBankLine>>(
  {
    ...own,
    money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount", required: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    description: { type: String, trim: true, maxlength: 300 },
    reference: { type: String, trim: true, maxlength: 80 },
    balance: { type: Number },
    status: { type: String, enum: ["open", "matched", "ignored"], default: "open" },
    voucher: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
    batch: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true },
);
BizBankLineSchema.index({ ownerKind: 1, ownerId: 1, money: 1, hash: 1 }, { unique: true });
BizBankLineSchema.index({ ownerKind: 1, ownerId: 1, money: 1, date: -1 });
export const BizBankLine = mongoose.model("BizBankLine", BizBankLineSchema);

// a cheque book (دسته‌چک) of a bank account
export interface IBizCheckbook extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  money?: mongoose.Types.ObjectId;
  bankName?: string;
  serial: string;
  fromNo: string;
  toNo: string;
  count: number;
  description?: string;
  isActive: boolean;
}
export const BizCheckbook = mongoose.model(
  "BizCheckbook",
  new mongoose.Schema<IBizCheckbook, Model<IBizCheckbook>>(
    {
      ...own,
      money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
      bankName: { type: String, trim: true, maxlength: 80 },
      serial: { type: String, required: true, trim: true, maxlength: 40 },
      fromNo: { type: String, required: true, trim: true, maxlength: 30 },
      toNo: { type: String, required: true, trim: true, maxlength: 30 },
      count: { type: Number, default: 0, min: 0 },
      description: { type: String, trim: true, maxlength: 300 },
      isActive: { type: Boolean, default: true },
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1, createdAt: -1 }),
);

// a trust / guarantee cheque held (چک امانی): not an asset, no voucher
export interface IBizTrustCheque extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  serial: string;
  bank?: string;
  amount: number;
  dueDate: Date;
  party?: mongoose.Types.ObjectId;
  partyName?: string;
  purpose?: string;
  createdAt: Date;
}
export const BizTrustCheque = mongoose.model(
  "BizTrustCheque",
  new mongoose.Schema<IBizTrustCheque, Model<IBizTrustCheque>>(
    {
      ...own,
      serial: { type: String, required: true, trim: true, maxlength: 40 },
      bank: { type: String, trim: true, maxlength: 80 },
      amount: { type: Number, required: true, min: 0 },
      dueDate: { type: Date, required: true },
      party: { type: mongoose.Schema.ObjectId, ref: "BizParty" },
      partyName: { type: String, trim: true, maxlength: 200 },
      purpose: { type: String, trim: true, maxlength: 300 },
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1, dueDate: 1 }),
);

// the owner's accounting settings (Nexxa saveAccountingSettings)
export interface IBizAccSettings extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  // a payment that would take a till or bank below zero
  negativeTreasury: "allow" | "warn" | "block";
  // the days a bank line and a book line may differ to auto-match
  matchDays: number;
}
export const BizAccSettings = mongoose.model(
  "BizAccSettings",
  new mongoose.Schema<IBizAccSettings, Model<IBizAccSettings>>(
    {
      ...own,
      negativeTreasury: { type: String, enum: ["allow", "warn", "block"], default: "warn" },
      matchDays: { type: Number, default: 5, min: 0, max: 60 },
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1 }, { unique: true }),
);

// a cost-allocation rule (تسهیم): a source centre's net expense split
// across target centres by percent
export interface IBizAllocation extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  title: string;
  source: mongoose.Types.ObjectId;
  lines: { target: mongoose.Types.ObjectId; percent: number }[];
  lastRunAt?: Date;
}
export const BizAllocation = mongoose.model(
  "BizAllocation",
  new mongoose.Schema<IBizAllocation, Model<IBizAllocation>>(
    {
      ...own,
      title: { type: String, required: true, trim: true, maxlength: 120 },
      source: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter", required: true },
      lines: {
        type: [new mongoose.Schema({ target: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" }, percent: Number }, { _id: false })],
        default: [],
      },
      lastRunAt: Date,
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1 }),
);

// the price list (تعرفه‌ی خدمات و کالا) invoices and quick sales pick from
export interface IBizPriceItem extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  code?: string;
  title: string;
  group?: string;
  unit?: string;
  price: number;
  // the insurers' tariff, when it differs from the free price
  insurancePrice?: number;
  taxRate: number;
  account?: mongoose.Types.ObjectId;
  isActive: boolean;
}
export const BizPriceItem = mongoose.model(
  "BizPriceItem",
  new mongoose.Schema<IBizPriceItem, Model<IBizPriceItem>>(
    {
      ...own,
      code: { type: String, trim: true, maxlength: 30 },
      title: { type: String, required: true, trim: true, maxlength: 200 },
      group: { type: String, trim: true, maxlength: 80 },
      unit: { type: String, trim: true, maxlength: 30 },
      price: { type: Number, default: 0, min: 0 },
      insurancePrice: { type: Number, min: 0 },
      taxRate: { type: Number, default: 0, min: 0, max: 100 },
      account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
      isActive: { type: Boolean, default: true },
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1, title: 1 }),
);
