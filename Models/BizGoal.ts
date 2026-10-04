import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A target of one staff member or the whole centre (2026-10, Nexxa
// SalesGoal + SalesGoalLine, goals.ts): a metric over a period, its
// progress always read from the real records. A service-sales target is
// the sum of its lines (one per service: a count or an amount).
export const bizGoalMetrics = ["wonValue", "wonCount", "leadsCreated", "plansSent", "invoiced", "serviceSales"] as const;

export interface IBizGoalLine {
  _id: mongoose.Types.ObjectId;
  label: string;
  service?: mongoose.Types.ObjectId;
  targetQty: number;
  targetValue: number;
}

export interface IBizGoal extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  title: string;
  assignee?: mongoose.Types.ObjectId;
  metric: (typeof bizGoalMetrics)[number];
  target: number;
  period: "month" | "quarter" | "year" | "custom";
  startDate: Date;
  endDate: Date;
  lines: IBizGoalLine[];
  createdAt: Date;
}

const LineSchema = new mongoose.Schema<IBizGoalLine>({
  label: { type: String, trim: true, maxlength: 200, default: "" },
  service: { type: mongoose.Schema.ObjectId },
  targetQty: { type: Number, default: 0, min: 0 },
  targetValue: { type: Number, default: 0, min: 0 },
});

const BizGoalSchema = new mongoose.Schema<IBizGoal, Model<IBizGoal>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    metric: { type: String, enum: bizGoalMetrics, required: true },
    target: { type: Number, required: true, min: 0 },
    period: { type: String, enum: ["month", "quarter", "year", "custom"], default: "month" },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    lines: { type: [LineSchema], default: [] },
  },
  { timestamps: true },
);

BizGoalSchema.index({ ownerKind: 1, ownerId: 1, endDate: -1 });

const BizGoal = mongoose.model("BizGoal", BizGoalSchema);
export default BizGoal;
