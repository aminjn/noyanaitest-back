import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// An expense of one owner (2026-10, Lib/business/expenses.ts): rent, a
// utility bill, consumables, an outside lab... booked to an expense
// account, with its VAT, vendor, cost centre and the receipt's photo.
// Unpaid it is owed to the vendor («بستانکاران»), paid it leaves the till
// or the bank. A recurring one is a template: every period a new expense is
// written from it (the rent on the first of each month).
export const bizRecurIntervals = ["monthly", "quarterly", "yearly"] as const;

export interface IBizExpense extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  date: Date;
  dueDate?: Date;
  account: mongoose.Types.ObjectId;
  vendor?: string;
  supplier?: mongoose.Types.ObjectId;
  description: string;
  amount: number;
  tax: number;
  total: number;
  paid: number;
  center?: mongoose.Types.ObjectId;
  attachment?: string;
  isVoid: boolean;
  // a template: not booked itself, writes an expense every period
  recurring?: {
    interval: (typeof bizRecurIntervals)[number];
    nextDate: Date;
    until?: Date;
    isActive: boolean;
    // the till/bank it is paid from automatically, if it is
    payFrom?: mongoose.Types.ObjectId;
  };
  // the template an expense was written from
  template?: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizExpenseSchema = new mongoose.Schema<IBizExpense, Model<IBizExpense>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    date: { type: Date, required: true },
    dueDate: { type: Date },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
    vendor: { type: String, trim: true, maxlength: 200 },
    supplier: { type: mongoose.Schema.ObjectId, ref: "BizSupplier" },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    amount: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    paid: { type: Number, default: 0 },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    attachment: { type: String, maxlength: 300 },
    isVoid: { type: Boolean, default: false },
    recurring: {
      type: new mongoose.Schema(
        {
          interval: { type: String, enum: bizRecurIntervals, required: true },
          nextDate: { type: Date, required: true },
          until: { type: Date },
          isActive: { type: Boolean, default: true },
          payFrom: { type: mongoose.Schema.ObjectId, ref: "BizMoneyAccount" },
        },
        { _id: false },
      ),
      default: undefined,
    },
    template: { type: mongoose.Schema.ObjectId, ref: "BizExpense" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizExpenseSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizExpenseSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizExpenseSchema.index({ "recurring.isActive": 1, "recurring.nextDate": 1 });
// one expense per template and date
BizExpenseSchema.index({ template: 1, date: 1 }, { unique: true, partialFilterExpression: { template: { $exists: true } } });

const BizExpense = mongoose.model("BizExpense", BizExpenseSchema);
export default BizExpense;
