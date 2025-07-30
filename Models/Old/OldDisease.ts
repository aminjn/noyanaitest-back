import mongoose, { Model } from "mongoose";
import { IOldSpeciality } from "./oldSpeciality";
import { MongoDoc } from "../User";
import { IOldSymptom } from "./OldSymptom";
import { IOldDrug } from "./OldDrug";

export interface IOldDisease extends MongoDoc {
  name: string;
  description?: string;
  summary?: string;
  symptoms: IOldSymptom[];
  specialities: IOldSpeciality[];
  drugs: IOldDrug[];
  genderSpecific?: string;
  expectedPrognosis?: string;
  image?: string;
  naturalProgression?: string;
  pathophysiology?: string;
  sameAs: IOldDisease[];
  possibleComlplication?: string;
  order: number;
}

const diseaseSchema = new mongoose.Schema<IOldDisease, Model<IOldDisease>>({
  name: { type: String, required: true, unique: true, trim: true },
  description: { type: String },
  summary: { type: String },
  symptoms: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Symptom" }],
    default: [],
  },
  specialities: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Speciality" }],
    default: [],
  },
  drugs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Drug" }],
    default: [],
  },
  genderSpecific: { type: String },
  expectedPrognosis: { type: String, trim: true },
  image: { type: String },
  naturalProgression: { type: String, trim: true },
  pathophysiology: { type: String, trim: true },
  sameAs: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "Disease" }],
    default: [],
  },
  possibleComlplication: { type: String, trim: true },
  order: { type: Number, default: 0 },
});

const OldDisease = mongoose.connection
  .useDb("Noyan")
  .model("Disease", diseaseSchema);

export default OldDisease;
