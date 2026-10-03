import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One employee of one owner (2026-10, Lib/business/payroll.ts): a
// secretary, a nurse, a lab technician, a pharmacy's technical manager. The
// contract sets the base salary; the legal allowances (housing, food, child)
// come from the year's rules when the flags are on. Amounts in toman.
export interface IBizEmployee extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  nationalId?: string;
  mobile?: string;
  position?: string;
  hireDate?: Date;
  endDate?: Date;
  baseSalary: number;
  housing: boolean;
  food: boolean;
  children: number;
  insured: boolean;
  insuranceNo?: string;
  taxable: boolean;
  iban?: string;
  isActive: boolean;
  note?: string;
  // what the Tamin monthly list (DSKWOR00) asks for each insured person
  firstName?: string;
  lastName?: string;
  fatherName?: string;
  idNumber?: string;
  idPlace?: string;
  birthDate?: Date;
  gender?: "male" | "female";
  nationality?: string;
  jobCode?: string;
}

const BizEmployeeSchema = new mongoose.Schema<IBizEmployee, Model<IBizEmployee>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    nationalId: { type: String, trim: true, maxlength: 10 },
    mobile: { type: String, trim: true, maxlength: 20 },
    position: { type: String, trim: true, maxlength: 100 },
    hireDate: { type: Date },
    endDate: { type: Date },
    baseSalary: { type: Number, required: true, min: 0 },
    housing: { type: Boolean, default: true },
    food: { type: Boolean, default: true },
    children: { type: Number, default: 0, min: 0, max: 20 },
    insured: { type: Boolean, default: true },
    insuranceNo: { type: String, trim: true, maxlength: 20 },
    taxable: { type: Boolean, default: true },
    iban: { type: String, trim: true, maxlength: 34 },
    isActive: { type: Boolean, default: true },
    note: { type: String, trim: true, maxlength: 500 },
    firstName: { type: String, trim: true, maxlength: 100 },
    lastName: { type: String, trim: true, maxlength: 100 },
    fatherName: { type: String, trim: true, maxlength: 100 },
    idNumber: { type: String, trim: true, maxlength: 15 },
    idPlace: { type: String, trim: true, maxlength: 100 },
    birthDate: { type: Date },
    gender: { type: String, enum: ["male", "female"] },
    nationality: { type: String, trim: true, maxlength: 20 },
    jobCode: { type: String, trim: true, maxlength: 6 },
  },
  { timestamps: true },
);

BizEmployeeSchema.index({ ownerKind: 1, ownerId: 1, name: 1 });

const BizEmployee = mongoose.model("BizEmployee", BizEmployeeSchema);
export default BizEmployee;
