import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPart } from "./Part";
import { GenderSpecificOption, genderSpicificOptions } from "./Disease";

export interface ISymptom extends MongoDoc {
  name?: string;
  genderSpecific?: GenderSpecificOption;
  part: IPart[];
  summary?: string;
  description?: string;
  expectedPrognosis?: string;
  image?: string;
  naturalProgression?: string;
  pathophysiology?: string;
  sameAs: ISymptom[];
  possibleComplication?: string;
  order: number;
  slug?: string;
  old: mongoose.Types.ObjectId;
}

const SymptomSchema = new mongoose.Schema<ISymptom, Model<ISymptom>>({
  name: { type: String },
  genderSpecific: { type: String, enum: genderSpicificOptions },
  part: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Part", required: true }],
    default: [],
  },
  summary: { type: String },
  description: { type: String },
  expectedPrognosis: { type: String },
  image: { type: String },
  naturalProgression: { type: String },
  pathophysiology: { type: String },
  sameAs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Symptom", required: true }],
    default: [],
  },
  possibleComplication: { type: String },
  order: { type: Number, default: 0 },
  slug: { type: String, unique: true, sparse: true },
  old: { type: mongoose.Schema.ObjectId },
});

const Symptom = mongoose.model("Symptom", SymptomSchema);

export default Symptom;
