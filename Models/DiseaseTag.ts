import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const diseaseTagLevels = [
  "Warning",
  "Info",
  "Success",
  "Error",
  "Primarylight",
  "Primary",
  "Secondary",
  "SecondaryLight",
  "Black",
  "Disabled",
] as const;

export type DiseaseTagLevel = (typeof diseaseTagLevels)[number];

export interface IDiseaseTag extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
  level: DiseaseTagLevel;
}

const DiseaseTagSchema = new mongoose.Schema<IDiseaseTag, Model<IDiseaseTag>>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  level: { type: String, enum: diseaseTagLevels, default: "Primary" },
});

DiseaseTagSchema.plugin(translatable);

const DiseaseTag = mongoose.model("DiseaseTag", DiseaseTagSchema);

export default DiseaseTag;
