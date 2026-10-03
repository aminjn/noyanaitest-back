import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The workshop (کارگاه) an owner is registered as with Tamin, for the
// monthly insurance list disk (2026-10, Lib/business/taminDisk.ts).
export const diskEncodings = ["iransystem", "windows1256"] as const;
// and for the salary tax list files (WP, WH) of my.tax.gov.ir
export const taxEncodings = ["windows1256", "utf8"] as const;
export const workplaceStatuses = ["normal", "lessDeveloped", "freeZone"] as const;

export interface IBizPayrollSettings extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  workshopCode?: string;
  workshopName?: string;
  employerName?: string;
  address?: string;
  // ردیف پیمان: 000 for an ordinary workshop
  contractRow: string;
  listNo: string;
  encoding: (typeof diskEncodings)[number];
  taxEncoding: (typeof taxEncodings)[number];
  // مناطق کمتر توسعه‌یافته and free zones have their own exemptions
  workplaceStatus: (typeof workplaceStatuses)[number];
}

const BizPayrollSettingsSchema = new mongoose.Schema<IBizPayrollSettings, Model<IBizPayrollSettings>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    workshopCode: { type: String, trim: true, maxlength: 10 },
    workshopName: { type: String, trim: true, maxlength: 100 },
    employerName: { type: String, trim: true, maxlength: 100 },
    address: { type: String, trim: true, maxlength: 100 },
    contractRow: { type: String, trim: true, default: "000", maxlength: 3 },
    listNo: { type: String, trim: true, default: "01", maxlength: 12 },
    encoding: { type: String, enum: diskEncodings, default: "iransystem" },
    taxEncoding: { type: String, enum: taxEncodings, default: "windows1256" },
    workplaceStatus: { type: String, enum: workplaceStatuses, default: "normal" },
  },
  { timestamps: true },
);

BizPayrollSettingsSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });

const BizPayrollSettings = mongoose.model("BizPayrollSettings", BizPayrollSettingsSchema);
export default BizPayrollSettings;
