import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ISymptom } from "./Symptom";
import { ISpeciality } from "./Speciality";
import { IDrug } from "./Drug";
import { genders } from "./BecomeDoctorRequest";

export const genderSpicificOptions = ["male", "female", "none"] as const;

export type GenderSpecificOption = (typeof genderSpicificOptions)[number];

export interface IDisease extends MongoDoc {
  name?: string;
  description?: string;
  summary?: string;
  symptoms: ISymptom[];
  specialities: ISpeciality[];
  drugs: IDrug[];
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
}

const DiseaseSchema = new mongoose.Schema<IDisease, Model<IDisease>>({
  name: { type: String },
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
  genderSpecific: { type: String, enum: genders },
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
});

const Disease = mongoose.model("Disease", DiseaseSchema);

export default Disease;
