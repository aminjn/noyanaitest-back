import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";
import {
  IMedicalContentFields,
  medicalContentFields,
  medicalReviewPlugin,
} from "../Lib/medicalContent";
import { IPart } from "./Part";
import {
  GenderSpecificOption,
  genderSpicificOptions,
  IDisease,
} from "./Disease";
import { ISymptomCategory } from "./SymptomCategory";

export interface ISymptom extends MongoDoc, IMedicalContentFields {
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
  averageScore: number;
  commentCount: number;
}

const SymptomSchema = new mongoose.Schema<ISymptom, Model<ISymptom>>(
  {
    name: { type: String, trim: true, required: true },
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
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  ...medicalContentFields,
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

SymptomSchema.virtual("diseases", {
  ref: "Disease",
  localField: "_id",
  foreignField: "symptoms",
});

SymptomSchema.plugin(translatable);
clearsDirectoryCache(SymptomSchema);
SymptomSchema.plugin(medicalReviewPlugin);

const Symptom = mongoose.model("Symptom", SymptomSchema);

export default Symptom;
