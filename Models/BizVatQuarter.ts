import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One settled quarter of an owner's VAT (2026-10, Lib/business/vatReturn.ts):
// the quarter's output VAT offset against the creditable input VAT and the
// credit carried from earlier quarters (تهاتر), the purchase VAT that is not
// creditable moved to expense, and what is left either payable to the tax
// office or carried to the next quarter. Undone (its voucher reversed) only
// while nothing of it was paid. Amounts in toman.
export interface IBizVatQuarter extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  year: number;
  quarter: number;
  start: Date;
  end: Date;
  output: number;
  creditable: number;
  nonCreditable: number;
  carried: number;
  offset: number;
  payable: number;
  credit: number;
  // which settlement is current: refs vat:<year>-<quarter>:<seq> (and :rev)
  seq: number;
  settledAt: Date;
  paidAt?: Date;
  paidVia?: mongoose.Types.ObjectId;
  createdBy?: IUser;
}

const num = { type: Number, default: 0 };

const BizVatQuarterSchema = new mongoose.Schema<IBizVatQuarter, Model<IBizVatQuarter>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    year: { type: Number, required: true },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    output: num,
    creditable: num,
    nonCreditable: num,
    carried: num,
    offset: num,
    payable: num,
    credit: num,
    seq: { type: Number, default: 1 },
    settledAt: { type: Date, default: () => new Date() },
    paidAt: Date,
    paidVia: { type: mongoose.Schema.ObjectId, ref: "BizAccount" },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizVatQuarterSchema.index({ ownerKind: 1, ownerId: 1, year: 1, quarter: 1 }, { unique: true });

const BizVatQuarter = mongoose.model("BizVatQuarter", BizVatQuarterSchema);
export default BizVatQuarter;
