import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ISymptom extends MongoDoc {}

const SymptomSchema = new mongoose.Schema<ISymptom, Model<ISymptom>>({});

const Symptom = mongoose.model("Symptom", SymptomSchema);

export default Symptom;
