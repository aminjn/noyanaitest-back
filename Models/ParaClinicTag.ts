import { noRoundTheClockTagPlugin } from "../Lib/openingHours";
import { translatable } from "../Lib/i18n/translatable";
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

ParaClinicTagSchema.plugin(translatable);
// "round the clock" is the opening hours, not a tag (2026-10)
ParaClinicTagSchema.plugin(noRoundTheClockTagPlugin);

const ParaClinicTag = mongoose.model("ParaClinicTag", ParaClinicTagSchema);

export default ParaClinicTag;
