import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDrugTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
}

const DrugTagSchema = new mongoose.Schema<IDrugTag, Model<IDrugTag>>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number },
});

const DrugTag = mongoose.model("DrugTag", DrugTagSchema);

export default DrugTag;
