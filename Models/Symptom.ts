import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPart } from "./Part";
import {
  GenderSpecificOption,
  genderSpicificOptions,
  IDisease,
} from "./Disease";
import { ISymptomCategory } from "./SymptomCategory";

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
  diseases: IDisease[];
  category?: ISymptomCategory;
  aiSummary?: string;
  content?: string;
}

const SymptomSchema = new mongoose.Schema<ISymptom, Model<ISymptom>>(
  {
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
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Symptom", required: true },
      ],
      default: [],
    },
    possibleComplication: { type: String },
    order: { type: Number, default: 0 },
    slug: { type: String, unique: true, sparse: true },
    old: { type: mongoose.Schema.ObjectId },
    category: { type: mongoose.Schema.ObjectId, ref: "SymptomCategory" },
    aiSummary: { type: String },
    content: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

SymptomSchema.virtual("diseases", {
  ref: "Disease",
  localField: "_id",
  foreignField: "symptoms",
});

const Symptom = mongoose.model("Symptom", SymptomSchema);

export default Symptom;
