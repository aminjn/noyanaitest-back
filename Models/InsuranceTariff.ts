import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInsurance } from "./Insurance";
import { IInsurancePlan } from "./InsurancePlan";
import { ISpeciality } from "./Speciality";

// An insurer's coverage rule for a doctor's visit (2026-10, «تعرفه‌ها»,
// Lib/insuranceTariffs.ts). One insurer has many: by plan (none = every
// plan of the insurer), by visit type, by the doctor's level or speciality
// and optionally by a service or package. The most specific valid rule
// wins. What it pays:
//   percent    - this percent of the visit price (a supplementary insurer
//                stacked after a basic one: of what is left)
//   fixed      - a fixed amount per visit
//   govTariff  - this percent of the approved government tariff
//                (Tamin, Salamat, the armed forces: «تعرفه‌ی مصوب»), never
//                more than the price charged
// then never more than the per-visit ceiling, and the patient always pays
// at least the copay (فرانشیز ثابت). An optional monthly or yearly limit
// (visits and/or amount) is counted per patient over the Jalali month or
// year, Tehran time.

export const tariffVisitKinds = ["any", "inPerson", "online"] as const;
export type TariffVisitKind = (typeof tariffVisitKinds)[number];

export const doctorLevels = ["general", "specialist", "subspecialist"] as const;
export type DoctorLevel = (typeof doctorLevels)[number];
export const tariffLevels = ["any", ...doctorLevels] as const;
export type TariffLevel = (typeof tariffLevels)[number];

export const tariffMethods = ["percent", "fixed", "govTariff"] as const;
export type TariffMethod = (typeof tariffMethods)[number];

export const tariffLimitPeriods = ["none", "month", "year"] as const;
export type TariffLimitPeriod = (typeof tariffLimitPeriods)[number];

export interface IInsuranceTariff extends MongoDoc {
  insurance: IInsurance;
  plan?: IInsurancePlan | null;
  title?: string;
  visitKind: TariffVisitKind;
  level: TariffLevel;
  speciality?: ISpeciality | null;
  service?: mongoose.Types.ObjectId | null;
  servicePackage?: mongoose.Types.ObjectId | null;
  method: TariffMethod;
  percent: number;
  amount: number;
  govTariff: number;
  ceiling: number;
  copay: number;
  limitPeriod: TariffLimitPeriod;
  limitCount: number;
  limitAmount: number;
  validFrom?: Date | null;
  validTo?: Date | null;
  active: boolean;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InsuranceTariffSchema = new mongoose.Schema<IInsuranceTariff, Model<IInsuranceTariff>>(
  {
    insurance: { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
    plan: { type: mongoose.Schema.ObjectId, ref: "InsurancePlan", default: null },
    title: { type: String, trim: true, maxlength: 120 },
    visitKind: { type: String, enum: tariffVisitKinds, default: "any" },
    level: { type: String, enum: tariffLevels, default: "any" },
    speciality: { type: mongoose.Schema.ObjectId, ref: "Speciality", default: null },
    service: { type: mongoose.Schema.ObjectId, ref: "Service", default: null },
    servicePackage: { type: mongoose.Schema.ObjectId, ref: "ServicePackage", default: null },
    method: { type: String, enum: tariffMethods, required: true },
    percent: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, default: 0, min: 0 },
    govTariff: { type: Number, default: 0, min: 0 },
    ceiling: { type: Number, default: 0, min: 0 },
    copay: { type: Number, default: 0, min: 0 },
    limitPeriod: { type: String, enum: tariffLimitPeriods, default: "none" },
    limitCount: { type: Number, default: 0, min: 0 },
    limitAmount: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    active: { type: Boolean, default: true },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

InsuranceTariffSchema.index({ insurance: 1, active: 1 });

const InsuranceTariff = mongoose.model("InsuranceTariff", InsuranceTariffSchema);

export default InsuranceTariff;
