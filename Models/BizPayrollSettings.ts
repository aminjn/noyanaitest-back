import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The workshop (کارگاه) an owner is registered as with Tamin, for the
// monthly insurance list disk (2026-10, Lib/business/taminDisk.ts).
export const diskEncodings = ["iransystem", "windows1256"] as const;

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
  },
  { timestamps: true },
);

BizPayrollSettingsSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });

const BizPayrollSettings = mongoose.model("BizPayrollSettings", BizPayrollSettingsSchema);
export default BizPayrollSettings;
