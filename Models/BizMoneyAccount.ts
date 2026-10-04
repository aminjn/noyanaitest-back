import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A till, a bank account or a card reader (POS) of one owner (2026-10,
// Lib/business/payments.ts). Each is one detail account under «موجودی نقد»
// (11) in the owner's books; this row carries what the ledger cannot: the
// bank, the account number and Sheba, and the bank-statement lines the
// owner ticked off (simple reconciliation).
export const bizMoneyKinds = ["cash", "bank", "pos", "wallet"] as const;
export type BizMoneyKind = (typeof bizMoneyKinds)[number];

export interface IBizMoneyAccount extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  account: mongoose.Types.ObjectId;
  kind: BizMoneyKind;
  name: string;
  bankName?: string;
  accountNumber?: string;
  sheba?: string;
  isActive: boolean;
  // vouchers whose line on this account matched the bank statement
  reconciled: mongoose.Types.ObjectId[];
  // the last statement the owner reconciled against
  statementBalance?: number;
  statementDate?: Date;
}

const BizMoneyAccountSchema = new mongoose.Schema<IBizMoneyAccount, Model<IBizMoneyAccount>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
    kind: { type: String, enum: bizMoneyKinds, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    bankName: { type: String, trim: true, maxlength: 80 },
    accountNumber: { type: String, trim: true, maxlength: 40 },
    sheba: { type: String, trim: true, maxlength: 34 },
    isActive: { type: Boolean, default: true },
    reconciled: { type: [mongoose.Schema.ObjectId], default: [] },
    statementBalance: { type: Number },
    statementDate: { type: Date },
  },
  { timestamps: true },
);

BizMoneyAccountSchema.index({ ownerKind: 1, ownerId: 1, account: 1 }, { unique: true });

const BizMoneyAccount = mongoose.model("BizMoneyAccount", BizMoneyAccountSchema);
export default BizMoneyAccount;
