import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The audit trail of hand-typed vouchers (2026-10, Lib/business/journal.ts):
// every create, edit, finalize, back-to-draft and delete, with who did it
// and the voucher as it was before and after. Automatic vouchers change
// only through their documents, which keep their own history.
export const bizAuditActions = ["create", "update", "finalize", "revert", "delete", "attach", "import"] as const;

export type AuditSnapshot = {
  date?: Date;
  description?: string;
  reference?: string;
  state?: string;
  total?: number;
  lines?: { code: string; party?: string; label?: string; debit: number; credit: number }[];
};

export interface IBizVoucherAudit extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  voucher: mongoose.Types.ObjectId;
  number: number;
  action: (typeof bizAuditActions)[number];
  by?: mongoose.Types.ObjectId;
  before?: AuditSnapshot;
  after?: AuditSnapshot;
  createdAt: Date;
}

const BizVoucherAuditSchema = new mongoose.Schema<IBizVoucherAudit, Model<IBizVoucherAudit>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    voucher: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number },
    action: { type: String, enum: bizAuditActions, required: true },
    by: { type: mongoose.Schema.ObjectId, ref: "User" },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

BizVoucherAuditSchema.index({ ownerKind: 1, ownerId: 1, createdAt: -1 });
BizVoucherAuditSchema.index({ voucher: 1, createdAt: 1 });

const BizVoucherAudit = mongoose.model("BizVoucherAudit", BizVoucherAuditSchema);
export default BizVoucherAudit;
