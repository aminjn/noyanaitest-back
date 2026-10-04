import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Fixed assets (2026-10, Lib/business/assets.ts, after Nexxa's FixedAsset /
// AssetGroup / AssetTransfer / AssetMaintenance / AssetRevaluation): an
// ultrasound, a dental unit, the reception furniture. The group sets the
// default depreciation (Iranian ماده‌ی ۱۴۹ presets) and the asset account.

export interface IBizAssetGroup extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  name: string;
  usefulLifeYears: number;
  method: "straight" | "declining";
  decliningRate: number;
  // the detail account (under 25) its assets are booked to
  account?: mongoose.Types.ObjectId;
}

const own = {
  ownerKind: { type: String, enum: bizOwnerKinds, required: true },
  ownerId: { type: mongoose.Schema.ObjectId },
};

export const BizAssetGroup = mongoose.model(
  "BizAssetGroup",
  new mongoose.Schema<IBizAssetGroup, Model<IBizAssetGroup>>(
    {
      ...own,
      name: { type: String, required: true, trim: true, maxlength: 120 },
      usefulLifeYears: { type: Number, default: 5, min: 1, max: 100 },
      method: { type: String, enum: ["straight", "declining"], default: "straight" },
      decliningRate: { type: Number, default: 0, min: 0, max: 100 },
      account: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1, name: 1 }),
);

export interface IBizFixedAsset extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  code: string;
  name: string;
  category: string;
  group?: mongoose.Types.ObjectId;
  account: mongoose.Types.ObjectId;
  acquisitionDate: Date;
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  method: "straight" | "declining";
  decliningRate: number;
  accumulatedDep: number;
  lastDepDate?: Date;
  state: "active" | "disposed";
  serial?: string;
  location?: string;
  custodian?: string;
  center?: mongoose.Types.ObjectId;
  disposalDate?: Date;
  disposalProceeds: number;
  disposalNote?: string;
  revaluedAt?: Date;
  revaluationSurplus: number;
  // the acquisition voucher's ref, if one was booked
  voucherRef?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizFixedAssetSchema = new mongoose.Schema<IBizFixedAsset, Model<IBizFixedAsset>>(
  {
    ...own,
    code: { type: String, required: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, trim: true, maxlength: 120, default: "" },
    group: { type: mongoose.Schema.ObjectId, ref: "BizAssetGroup" },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
    acquisitionDate: { type: Date, required: true },
    cost: { type: Number, required: true, min: 0 },
    salvageValue: { type: Number, default: 0, min: 0 },
    usefulLifeYears: { type: Number, default: 5, min: 1, max: 100 },
    method: { type: String, enum: ["straight", "declining"], default: "straight" },
    decliningRate: { type: Number, default: 0, min: 0, max: 100 },
    accumulatedDep: { type: Number, default: 0, min: 0 },
    lastDepDate: { type: Date },
    state: { type: String, enum: ["active", "disposed"], default: "active" },
    serial: { type: String, trim: true, maxlength: 80 },
    location: { type: String, trim: true, maxlength: 200 },
    custodian: { type: String, trim: true, maxlength: 200 },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    disposalDate: { type: Date },
    disposalProceeds: { type: Number, default: 0 },
    disposalNote: { type: String, trim: true, maxlength: 500 },
    revaluedAt: { type: Date },
    revaluationSurplus: { type: Number, default: 0 },
    voucherRef: { type: String },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);
BizFixedAssetSchema.index({ ownerKind: 1, ownerId: 1, code: 1 }, { unique: true });
BizFixedAssetSchema.index({ ownerKind: 1, ownerId: 1, state: 1 });

export const BizFixedAsset = mongoose.model("BizFixedAsset", BizFixedAssetSchema);

// one event of an asset's life: moved (location / custodian), serviced, revalued
export interface IBizAssetEvent extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  asset: mongoose.Types.ObjectId;
  kind: "transfer" | "maintenance" | "revaluation";
  date: Date;
  note?: string;
  fromLocation?: string;
  toLocation?: string;
  fromCustodian?: string;
  toCustodian?: string;
  maintenanceKind?: "repair" | "service" | "inspection" | "upgrade";
  cost?: number;
  vendor?: string;
  nextDueDate?: Date;
  money?: mongoose.Types.ObjectId;
  oldCost?: number;
  oldAccum?: number;
  oldNbv?: number;
  fairValue?: number;
  surplus?: number;
  equityPortion?: number;
  voucherRef?: string;
  createdAt: Date;
}

export const BizAssetEvent = mongoose.model(
  "BizAssetEvent",
  new mongoose.Schema<IBizAssetEvent, Model<IBizAssetEvent>>(
    {
      ...own,
      asset: { type: mongoose.Schema.ObjectId, ref: "BizFixedAsset", required: true },
      kind: { type: String, enum: ["transfer", "maintenance", "revaluation"], required: true },
      date: { type: Date, required: true },
      note: { type: String, trim: true, maxlength: 500 },
      fromLocation: String,
      toLocation: String,
      fromCustodian: String,
      toCustodian: String,
      maintenanceKind: { type: String, enum: ["repair", "service", "inspection", "upgrade"] },
      cost: Number,
      vendor: { type: String, trim: true, maxlength: 200 },
      nextDueDate: Date,
      money: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
      oldCost: Number,
      oldAccum: Number,
      oldNbv: Number,
      fairValue: Number,
      surplus: Number,
      equityPortion: Number,
      voucherRef: String,
    },
    { timestamps: true },
  ).index({ ownerKind: 1, ownerId: 1, asset: 1, date: -1 }),
);
