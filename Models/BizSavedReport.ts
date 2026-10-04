import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A saved report of the report builder (Nexxa SavedReport) or a saved view
// of the pipeline board (Nexxa SavedView, kind "view": personal unless
// shared; only its maker deletes it).
export interface IBizSavedReport extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: "report" | "view";
  name: string;
  entity: "lead" | "contact" | "plan";
  config: Record<string, unknown>;
  shared: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizSavedReportSchema = new mongoose.Schema<IBizSavedReport, Model<IBizSavedReport>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: ["report", "view"], default: "report" },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    entity: { type: String, enum: ["lead", "contact", "plan"], default: "lead" },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    shared: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizSavedReportSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, createdAt: -1 });

const BizSavedReport = mongoose.model("BizSavedReport", BizSavedReportSchema);
export default BizSavedReport;
