import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IParaClinicTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
}

const ParaClinicTagSchema = new mongoose.Schema<
  IParaClinicTag,
  Model<IParaClinicTag>
>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

const ParaClinicTag = mongoose.model("ParaClinicTag", ParaClinicTagSchema);

export default ParaClinicTag;
