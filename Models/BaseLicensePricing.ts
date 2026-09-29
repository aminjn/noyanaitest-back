import mongoose from "mongoose";
import { ILicenseDuration } from "./LicenseDuration";

// Shared pricing-option shape embedded in every Base<Org>License catalog
// model (BaseDoctorLicense, BasePharmacyLicense, BaseClinicLicense,
// BaseParaClinicLicense) as of 2026-09, replacing the old flat
// monthlyPrice/monthlyDiscount/annualPrice/annualDiscount fields. Each
// entry prices a plan for one Models/LicenseDuration.ts catalog entry -
// `isActive: false` means that duration isn't offered for this plan (the
// purchase endpoint refuses to sell an inactive duration, see
// <org>Controller.ts purchaseLicense).
export interface IBaseLicensePricing {
  duration: mongoose.Types.ObjectId | ILicenseDuration;
  isActive: boolean;
  price: number;
  discount: number;
}

export const BaseLicensePricingSchema = new mongoose.Schema<IBaseLicensePricing>(
  {
    duration: {
      type: mongoose.Schema.ObjectId,
      ref: "LicenseDuration",
      required: true,
    },
    isActive: { type: Boolean, default: false },
    price: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);
