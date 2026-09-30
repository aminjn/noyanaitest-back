import mongoose from "mongoose";

// One price option of a Base<Org>License plan (2026-09, second pass): the
// period is part of the option itself - "3 months, 900,000 toman, 100,000
// off" - like Doctolib Pro / Paziresh24's monthly-quarterly-yearly plans.
// There is no separate duration catalog to define first any more (the old
// LicenseDuration model; Lib/migrateLicensePricing.ts moved its data in).
// `isActive: false` keeps a row on the plan without selling it.
export interface IBaseLicensePricing {
  // length of the license bought with this option, in days
  days: number;
  isActive: boolean;
  price: number;
  discount: number;
}

export const MAX_LICENSE_DAYS = 3650;

export const BaseLicensePricingSchema = new mongoose.Schema<IBaseLicensePricing>(
  {
    days: { type: Number, required: true, min: 1, max: MAX_LICENSE_DAYS },
    isActive: { type: Boolean, default: false },
    price: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);
