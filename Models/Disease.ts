import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";
import {
  IMedicalContentFields,
  medicalContentFields,
  medicalReviewPlugin,
} from "../Lib/medicalContent";
import { ISymptom } from "./Symptom";
import { ISpeciality } from "./Speciality";
import { IDrug } from "./Drug";
import { IDiseaseCategory } from "./DiseaseCategory";
import { IDiseaseTag } from "./DiseaseTag";
import { IPart } from "./Part";

export const genderSpicificOptions = ["male", "female", "none"] as const;

export type GenderSpecificOption = (typeof genderSpicificOptions)[number];

export interface IDisease extends MongoDoc, IMedicalContentFields {
  name?: string;
  description?: string;
  summary?: string;
  symptoms: ISymptom[];
  specialities: ISpeciality[];
  drugs: IDrug[];
  // body parts / systems it affects (the directory's "by body part"); the
  // parts of its symptoms count too (Controllers/directoryController)
  parts: IPart[];
  genderSpecific?: GenderSpecificOption;
  expectedPrognosis?: string;
  image?: string;
  naturalProgression?: string;
  pathophysiology?: string;
  sameAs: IDisease[];
  possibleComplication?: string;
  order: number;
  slug?: string;
  old: mongoose.Types.ObjectId;
  // retired (2026-10): folded into the category by
  // Lib/migrateMedicalDirectory and no longer edited or shown
  tag?: IDiseaseTag;
  category?: IDiseaseCategory;
  aiSummary?: string;
  content?: string;
  averageScore: number;
  commentCount: number;
}

const DiseaseSchema = new mongoose.Schema<IDisease, Model<IDisease>>({
  name: { type: String, trim: true, required: true },
  description: { type: String },
  summary: { type: String },
  symptoms: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Symptom", required: true }],
    default: [],
  },
  specialities: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "Speciality", required: true },
    ],
    default: [],
  },
  drugs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Drug", required: true }],
    default: [],
  },
  parts: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Part", required: true }],
    default: [],
  },
  genderSpecific: { type: String, enum: genderSpicificOptions },
  expectedPrognosis: { type: String },
  image: { type: String },
  naturalProgression: { type: String },
  pathophysiology: { type: String },
  sameAs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Disease", required: true }],
    default: [],
  },
  possibleComplication: { type: String },
  order: { type: Number, default: 0 },
  slug: { type: String, unique: true, sparse: true },
  old: { type: mongoose.Schema.ObjectId },
  tag: { type: mongoose.Schema.ObjectId, ref: "DiseaseTag" },
  category: { type: mongoose.Schema.ObjectId, ref: "DiseaseCategory" },
  aiSummary: { type: String },
  content: { type: String },
  averageScore: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  ...medicalContentFields,
});

DiseaseSchema.plugin(translatable);
clearsDirectoryCache(DiseaseSchema);
DiseaseSchema.plugin(medicalReviewPlugin);

const Disease = mongoose.model("Disease", DiseaseSchema);

export default Disease;
