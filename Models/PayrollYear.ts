import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// The payroll rules of one Iranian (Jalali) year (2026-10, Lib/business/
// payroll.ts): what the Supreme Labour Council and the budget law set each
// year - minimum wage, housing and food allowances, child allowance, the
// social-security shares and ceiling, overtime, and the salary-tax brackets.
// Set once by the super admin for the whole platform, so no provider has to
// know the law; a payroll run uses the year it belongs to. Amounts in toman.
export interface ITaxBracket {
  // upper end of the slice (monthly taxable income); null = everything above
  upTo: number | null;
  // percent
  rate: number;
}

export interface IPayrollYear extends MongoDoc {
  year: number;
  minWage: number;
  housing: number;
  food: number;
  childAllowance: number;
  employeeInsuranceRate: number;
  employerInsuranceRate: number;
  insuranceCeilingMultiplier: number;
  overtimeMultiplier: number;
  monthHours: number;
  taxExemption: number;
  brackets: ITaxBracket[];
  note?: string;
}

const PayrollYearSchema = new mongoose.Schema<IPayrollYear, Model<IPayrollYear>>(
  {
    year: { type: Number, required: true, unique: true, min: 1400, max: 1500 },
    minWage: { type: Number, required: true, min: 0 },
    housing: { type: Number, default: 0, min: 0 },
    food: { type: Number, default: 0, min: 0 },
    childAllowance: { type: Number, default: 0, min: 0 },
    employeeInsuranceRate: { type: Number, default: 7, min: 0, max: 100 },
    employerInsuranceRate: { type: Number, default: 23, min: 0, max: 100 },
    insuranceCeilingMultiplier: { type: Number, default: 7, min: 1 },
    overtimeMultiplier: { type: Number, default: 1.4, min: 1 },
    monthHours: { type: Number, default: 220, min: 1 },
    taxExemption: { type: Number, default: 0, min: 0 },
    brackets: {
      type: [{ _id: false, upTo: { type: Number, default: null }, rate: { type: Number, required: true, min: 0, max: 100 } }],
      default: [],
    },
    note: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

const PayrollYear = mongoose.model("PayrollYear", PayrollYearSchema);
export default PayrollYear;
