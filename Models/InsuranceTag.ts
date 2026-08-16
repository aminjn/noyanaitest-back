import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IInsuranceTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
}

const InsuranceTagSchema = new mongoose.Schema<
  IInsuranceTag,
  Model<IInsuranceTag>
>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

const InsuranceTag = mongoose.model("InsuranceTag", InsuranceTagSchema);

export default InsuranceTag;
