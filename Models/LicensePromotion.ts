import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { translatable } from "../Lib/i18n/translatable";

// A plan promotion (2026-10, owner decision: a launch discount for high
// adoption). Managed by the super admin under «پلن‌ها و مجوزها ← تخفیف و
// پیشنهاد ویژه»; applied by Lib/licenseQuote.ts in every purchaseLicense
// and in the pricing pages (strike-through price, badge, countdown).
//
// Like Doctolib's / Docplanner's launch offers ("first 3 months -50%"):
// percent or amount off, a start and an end, for whole provider kinds or
// chosen plans, optionally only for a provider's first purchase and
// optionally only with a promo code. The best single promotion wins; they
// never stack.
export const licensePromotionKinds = [
  "doctor",
  "clinic",
  "hospital",
  "pharmacy",
  "paraClinic",
  "insurance",
  // the patients' «پرو» membership (2026-10, Models/PatientProPlan.ts)
  "patient",
] as const;

export const licensePromotionTypes = ["percent", "amount"] as const;

export interface ILicensePromotion extends MongoDoc {
  // the badge shown on the price ("تخفیف ویژه‌ی افتتاحیه")
  title: string;
  isActive: boolean;
  discountType: (typeof licensePromotionTypes)[number];
  // percent (1-100) or toman
  value: number;
  // a percent promotion's cap in toman (0 = no cap)
  maxDiscount: number;
  startsAt: Date;
  endsAt: Date;
  // every plan of these provider kinds ...
  kinds: (typeof licensePromotionKinds)[number][];
  // ... and/or these plans (ids of any Base<Kind>License)
  plans: string[];
  firstPurchaseOnly: boolean;
  // empty = applied automatically; otherwise only with this code
  // (stored upper-case)
  code: string;
  // 0 = unlimited
  maxRedemptions: number;
  redemptions: number;
}

const LicensePromotionSchema = new mongoose.Schema<
  ILicensePromotion,
  Model<ILicensePromotion>
>(
  {
    title: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    discountType: { type: String, enum: licensePromotionTypes, default: "percent" },
    value: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: () => new Date() },
    endsAt: { type: Date, required: true },
    kinds: { type: [String], enum: licensePromotionKinds, default: [] },
    plans: { type: [String], default: [] },
    firstPurchaseOnly: { type: Boolean, default: false },
    code: { type: String, default: "", trim: true, uppercase: true },
    maxRedemptions: { type: Number, default: 0, min: 0 },
    redemptions: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

LicensePromotionSchema.index({ isActive: 1, endsAt: 1 });
LicensePromotionSchema.plugin(translatable);

const LicensePromotion = mongoose.model("LicensePromotion", LicensePromotionSchema);

export default LicensePromotion;

// One use of a promotion (a purchase it priced). Tells a provider's first
// purchase apart even when a 100% promotion left no wallet transaction.
export interface ILicensePromotionRedemption extends MongoDoc {
  promotion: mongoose.Types.ObjectId;
  kind: string;
  owner: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  plan: mongoose.Types.ObjectId;
  days: number;
  listPrice: number;
  discount: number;
  paid: number;
}

const RedemptionSchema = new mongoose.Schema<ILicensePromotionRedemption>(
  {
    promotion: { type: mongoose.Schema.ObjectId, ref: "LicensePromotion", required: true },
    kind: { type: String, required: true },
    owner: { type: mongoose.Schema.ObjectId, required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    plan: { type: mongoose.Schema.ObjectId },
    days: { type: Number },
    listPrice: { type: Number },
    discount: { type: Number },
    paid: { type: Number },
  },
  { timestamps: true },
);
RedemptionSchema.index({ kind: 1, owner: 1 });

export const LicensePromotionRedemption = mongoose.model(
  "LicensePromotionRedemption",
  RedemptionSchema,
);
