import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IDrugTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
}

const DrugTagSchema = new mongoose.Schema<IDrugTag, Model<IDrugTag>>({
  name: { type: String, trim: true, required: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number },
});

DrugTagSchema.plugin(translatable);

const DrugTag = mongoose.model("DrugTag", DrugTagSchema);

export default DrugTag;
