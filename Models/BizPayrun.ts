import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One month's payroll of one owner (2026-10, Lib/business/payroll.ts):
//   draft  - the slips are filled in (worked days, overtime, extras) and
//            recomputed on every save
//   posted - the voucher is in the books: salary expense and the employer's
//            insurance against net pay, insurance and tax owed
// Paying the salaries and paying insurance and tax to Tamin / the tax office
// are recorded on a posted run. A posted run goes back to draft (its voucher
// reversed) only while nothing of it was paid. Amounts in toman.
export interface IBizPayslip {
  employee: mongoose.Types.ObjectId;
  name: string;
  nationalId?: string;
  insuranceNo?: string;
  position?: string;
  workedDays: number;
  overtimeHours: number;
  otherEarnings: number;
  deductions: number;
  baseSalary: number;
  base: number;
  housing: number;
  food: number;
  child: number;
  overtime: number;
  gross: number;
  insuranceBase: number;
  insuranceEmployee: number;
  insuranceEmployer: number;
  taxableBase: number;
  tax: number;
  net: number;
}

export const bizPayrunStatuses = ["draft", "posted"] as const;

export interface IBizPayrun extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  year: number;
  month: number;
  // the first and last day of the Jalali month, for dates and display
  periodStart: Date;
  periodEnd: Date;
  status: (typeof bizPayrunStatuses)[number];
  slips: IBizPayslip[];
  totals: {
    gross: number;
    insuranceEmployee: number;
    insuranceEmployer: number;
    tax: number;
    deductions: number;
    net: number;
  };
  // which posting is current: refs payrun:<id>:<seq> (and :rev when undone)
  postSeq: number;
  postedAt?: Date;
  salariesPaidAt?: Date;
  salariesVia?: mongoose.Types.ObjectId;
  liabilitiesPaidAt?: Date;
  liabilitiesVia?: mongoose.Types.ObjectId;
  createdBy?: IUser;
}

const num = { type: Number, default: 0 };

const BizPayrunSchema = new mongoose.Schema<IBizPayrun, Model<IBizPayrun>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: { type: String, enum: bizPayrunStatuses, default: "draft" },
    slips: {
      type: [
        {
          _id: false,
          employee: { type: mongoose.Schema.ObjectId, ref: "BizEmployee", required: true },
          name: { type: String, required: true },
          nationalId: String,
          insuranceNo: String,
          position: String,
          workedDays: { type: Number, default: 30, min: 0, max: 31 },
          overtimeHours: { ...num, min: 0 },
          otherEarnings: { ...num, min: 0 },
          deductions: { ...num, min: 0 },
          baseSalary: num,
          base: num,
          housing: num,
          food: num,
          child: num,
          overtime: num,
          gross: num,
          insuranceBase: num,
          insuranceEmployee: num,
          insuranceEmployer: num,
          taxableBase: num,
          tax: num,
          net: num,
        },
      ],
      default: [],
    },
    totals: {
      gross: num,
      insuranceEmployee: num,
      insuranceEmployer: num,
      tax: num,
      deductions: num,
      net: num,
    },
    postSeq: { type: Number, default: 0 },
    postedAt: Date,
    salariesPaidAt: Date,
    salariesVia: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    liabilitiesPaidAt: Date,
    liabilitiesVia: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizPayrunSchema.index({ ownerKind: 1, ownerId: 1, year: 1, month: 1 }, { unique: true });

const BizPayrun = mongoose.model("BizPayrun", BizPayrunSchema);
export default BizPayrun;
