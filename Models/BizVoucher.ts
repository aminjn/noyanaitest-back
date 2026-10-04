import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One accounting voucher (سند) of one owner's books (Lib/business/voucher.ts).
// Always balanced. Automatic vouchers carry a ref (e.g. "tx:<id>") that is
// unique per owner, so posting the same event twice is a no-op; they are
// never edited or deleted by hand.
export const bizVoucherKinds = ["auto", "manual", "opening", "closing"] as const;
// the three vouchers of a year-end close (Lib/business/fiscalYear.ts):
//   pl    - income and expense accounts closed into retained earnings
//   final - اختتامیه: every balance-sheet account brought to zero at year end
//   open  - افتتاحیه: the same balances opened on the first day of the next
// Reports leave final and open out (they cancel across the year boundary)
// and the income statement leaves pl out too.
export const bizVoucherPhases = ["pl", "final", "open"] as const;

export interface IBizVoucherLine {
  account: mongoose.Types.ObjectId;
  // the account's code, kept with the line so reports need no join
  code: string;
  label?: string;
  debit: number;
  credit: number;
  // the تفصیلی (detail party) of the line - a patient, vendor, insurer...
  party?: mongoose.Types.ObjectId;
  // the line's cost centre (Nexxa JournalLine.costCenterId); when absent the
  // voucher's own centre counts
  center?: mongoose.Types.ObjectId;
}

export interface IBizVoucher extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId?: mongoose.Types.ObjectId;
  number: number;
  date: Date;
  kind: (typeof bizVoucherKinds)[number];
  ref?: string;
  description: string;
  // what it came from, for the link back (reservation, order, withdrawal...)
  source?: { type: string; id: mongoose.Types.ObjectId };
  lines: IBizVoucherLine[];
  total: number;
  createdBy?: IUser;
  phase?: (typeof bizVoucherPhases)[number];
  // the Jalali year a closing voucher belongs to
  fiscalYear?: number;
  // an automatic voucher that arrived after its year was closed is dated on
  // the first day of the open year; this is the date it really happened
  actualDate?: Date;
  // the cost centre a hand-typed voucher was booked to
  center?: mongoose.Types.ObjectId;
  // a hand-typed voucher's state (Nexxa journal: draft -> posted, and back
  // to draft to correct it). A draft is invisible to every report and sum:
  // the query hooks below leave it out unless a query asks for drafts.
  state?: "draft" | "final";
  // the reference typed on a manual voucher (Nexxa ref, «عطف»)
  reference?: string;
  draftNumber?: number;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  // the voucher this one reverses / the reversal of this one
  reverses?: mongoose.Types.ObjectId;
  reversedBy?: mongoose.Types.ObjectId;
  // the scans of the paper documents behind it (file paths)
  attachments?: string[];
  createdAt: Date;
}

const LineSchema = new mongoose.Schema<IBizVoucherLine>(
  {
    account: { type: mongoose.Schema.ObjectId, ref: "BizAccount", required: true },
    code: { type: String, required: true },
    label: { type: String, maxlength: 300 },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    party: { type: mongoose.Schema.ObjectId, ref: "BizParty" },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
  },
  { _id: false },
);

const SourceSchema = new mongoose.Schema(
  { type: { type: String }, id: { type: mongoose.Schema.ObjectId } },
  { _id: false },
);

const BizVoucherSchema = new mongoose.Schema<IBizVoucher, Model<IBizVoucher>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId },
    number: { type: Number, required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: bizVoucherKinds, default: "auto" },
    ref: { type: String },
    description: { type: String, maxlength: 500, default: "" },
    source: { type: SourceSchema, default: undefined },
    lines: { type: [LineSchema], validate: (v: unknown[]) => Array.isArray(v) && v.length >= 2 },
    total: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    phase: { type: String, enum: bizVoucherPhases },
    fiscalYear: { type: Number },
    actualDate: { type: Date },
    center: { type: mongoose.Schema.ObjectId, ref: "BizCostCenter" },
    state: { type: String, enum: ["draft", "final"] },
    reference: { type: String, trim: true, maxlength: 80 },
    draftNumber: { type: Number },
    approvedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    reverses: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
    reversedBy: { type: mongoose.Schema.ObjectId, ref: "BizVoucher" },
    attachments: { type: [String], default: undefined },
  },
  { timestamps: true },
);

BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizVoucherSchema.index(
  { ownerKind: 1, ownerId: 1, ref: 1 },
  { unique: true, partialFilterExpression: { ref: { $type: "string" } } },
);
BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, date: -1 });
BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, "lines.account": 1, date: 1 });
BizVoucherSchema.index({ ownerKind: 1, ownerId: 1, "lines.party": 1, date: 1 }, { partialFilterExpression: { "lines.party": { $exists: true } } });

// Drafts stay out of every read but the journal's own: a find, count or
// aggregate leaves out state "draft" unless it was given the option
// { withDrafts: true } (Lib/business/journal.ts).
const hideDrafts = function (this: mongoose.Query<unknown, unknown>) {
  const opts = this.getOptions() as { withDrafts?: boolean };
  if (opts.withDrafts) return;
  const f = this.getFilter() as Record<string, unknown>;
  if (f && Object.prototype.hasOwnProperty.call(f, "state")) return;
  this.where({ state: { $ne: "draft" } });
};
BizVoucherSchema.pre(["find", "findOne", "countDocuments", "distinct"], hideDrafts);
BizVoucherSchema.pre("aggregate", function () {
  const opts = (this.options || {}) as { withDrafts?: boolean };
  if (opts.withDrafts) return;
  const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
  if (first?.$match && Object.prototype.hasOwnProperty.call(first.$match, "state")) return;
  this.pipeline().unshift({ $match: { state: { $ne: "draft" } } });
});

const BizVoucher = mongoose.model("BizVoucher", BizVoucherSchema);

export default BizVoucher;
