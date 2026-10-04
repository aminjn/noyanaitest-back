import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One treatment / sales funnel of one owner (2026-10, Lib/business/
// crmSales.ts; Nexxa Pipeline + CrmStage + StageRule): its stages in order,
// each with a default probability and a blueprint - the fields a lead needs
// and whether it needs a logged activity before it may enter.
export interface IBizStage {
  _id: mongoose.Types.ObjectId;
  name: string;
  // a built-in stage's key (its name is shown in the reader's language
  // until the owner renames it)
  key?: string;
  sequence: number;
  probability: number;
  requiredFields: string[];
  requireActivity: boolean;
}

export interface IBizPipeline extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  isDefault: boolean;
  sequence: number;
  stages: IBizStage[];
  createdAt: Date;
}

const StageSchema = new mongoose.Schema<IBizStage>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  key: { type: String, maxlength: 30 },
  sequence: { type: Number, default: 0 },
  probability: { type: Number, default: 0, min: 0, max: 100 },
  requiredFields: { type: [String], default: [] },
  requireActivity: { type: Boolean, default: false },
});

const BizPipelineSchema = new mongoose.Schema<IBizPipeline, Model<IBizPipeline>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isDefault: { type: Boolean, default: false },
    sequence: { type: Number, default: 0 },
    stages: { type: [StageSchema], default: [] },
  },
  { timestamps: true },
);

BizPipelineSchema.index({ ownerKind: 1, ownerId: 1, sequence: 1 });

const BizPipeline = mongoose.model("BizPipeline", BizPipelineSchema);
export default BizPipeline;
