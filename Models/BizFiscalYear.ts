import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A closed Jalali fiscal year of one owner's books (2026-10,
// Lib/business/fiscalYear.ts). Once a year is here nothing dated inside it
// changes: a hand-typed voucher is refused and an automatic one that comes
// late is dated on the first day of the next year. Only the latest closed
// year can be opened again, which removes its three closing vouchers.
export interface IBizFiscalYear extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  year: number;
  start: Date;
  end: Date;
  profit: number;
  vouchers: { pl?: mongoose.Types.ObjectId; final?: mongoose.Types.ObjectId; open?: mongoose.Types.ObjectId };
  closedAt: Date;
  closedBy?: IUser;
}

const BizFiscalYearSchema = new mongoose.Schema<IBizFiscalYear, Model<IBizFiscalYear>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    year: { type: Number, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    profit: { type: Number, default: 0 },
    vouchers: {
      pl: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
      final: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
      open: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
    },
    closedAt: { type: Date, default: () => new Date() },
    closedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizFiscalYearSchema.index({ ownerKind: 1, ownerId: 1, year: 1 }, { unique: true });

const BizFiscalYear = mongoose.model("BizFiscalYear", BizFiscalYearSchema);

export default BizFiscalYear;
