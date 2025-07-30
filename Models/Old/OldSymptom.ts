import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IOldPart } from "./OldPart";
import { IOldDisease } from "./OldDisease";

export interface IOldSymptom extends MongoDoc {
  name: string;
  genderSpecific?: string;
  part: IOldPart[];
  summary?: string;
  description?: string;
  expectedPrognosis?: string;
  image?: string;
  naturalProgression?: string;
  pathophysiology?: string;
  sameAs: IOldSymptom[];
  possibleComplication?: string;
  diseases?: IOldDisease[];
  order: number;
}

const symptomSchema = new mongoose.Schema<IOldSymptom, Model<IOldSymptom>>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    genderSpecific: { type: String },
    part: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "Part", required: true }],
      default: [],
    },
    summary: { type: String },
    description: { type: String },
    expectedPrognosis: { type: String },
    image: { type: String },
    naturalProgression: { type: String, trim: true },
    pathophysiology: { type: String, trim: true },
    sameAs: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "Symptom" }],
      default: [],
    },
    possibleComplication: { type: String, trim: true },
    order: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

symptomSchema.virtual("diseases", {
  ref: "Disease",
  localField: "_id",
  foreignField: "symptoms",
  justOne: false,
});

const OldSymptom = mongoose.connection
  .useDb("Noyan")
  .model("Symptom", symptomSchema);

export default OldSymptom;
