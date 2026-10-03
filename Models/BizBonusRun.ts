import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A year's عیدی و سنوات of one owner (2026-10, Lib/business/bonus.ts): two
// months' last wage as Eid (at most three months' minimum wage) and one
// month's last wage as severance, both for the share of the year worked.
// Usually one run in Esfand for everyone; an employee who leaves mid-year
// gets a run of their own with their settlement. An employee is in one run
// a year. Neither is insured; severance is tax-free and Eid is taxed above
// the monthly exemption. draft -> posted -> paid, like a month's payroll.
export interface IBizBonusSlip {
  employee: mongoose.Types.ObjectId;
  name: string;
  nationalId?: string;
  days: number;
  baseSalary: number;
  eid: number;
  severance: number;
  tax: number;
  deductions: number;
  net: number;
}

export const bizBonusStatuses = ["draft", "posted"] as const;

export interface IBizBonusRun extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  year: number;
  yearDays: number;
  status: (typeof bizBonusStatuses)[number];
  slips: IBizBonusSlip[];
  totals: { eid: number; severance: number; tax: number; deductions: number; net: number };
  postSeq: number;
  postedAt?: Date;
  date?: Date;
  salariesPaidAt?: Date;
  liabilitiesPaidAt?: Date;
  createdBy?: IUser;
}

const num = { type: Number, default: 0 };

const BizBonusRunSchema = new mongoose.Schema<IBizBonusRun, Model<IBizBonusRun>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    year: { type: Number, required: true },
    yearDays: { type: Number, default: 365 },
    status: { type: String, enum: bizBonusStatuses, default: "draft" },
    slips: [
      {
        _id: false,
        employee: { type: mongoose.Schema.ObjectId, ref: "BizEmployee", required: true },
        name: { type: String, required: true },
        nationalId: String,
        days: { type: Number, default: 0, min: 0, max: 366 },
        baseSalary: num,
        eid: num,
        severance: num,
        tax: num,
        deductions: { ...num, min: 0 },
        net: num,
      },
    ],
    totals: { eid: num, severance: num, tax: num, deductions: num, net: num },
    postSeq: { type: Number, default: 0 },
    postedAt: Date,
    date: Date,
    salariesPaidAt: Date,
    liabilitiesPaidAt: Date,
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizBonusRunSchema.index({ ownerKind: 1, ownerId: 1, year: -1 });

const BizBonusRun = mongoose.model("BizBonusRun", BizBonusRunSchema);
export default BizBonusRun;
