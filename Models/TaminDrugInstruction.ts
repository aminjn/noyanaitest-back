import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminDrugInstruction extends MongoDoc {
  drugInstId?: string;
  drugInstCode?: string;
  drugInstSumry?: string;
  drugInstLatin?: string;
  drugInstConcept?: string;
}

const TaminDrugInstructionSchema = new mongoose.Schema<
  ITaminDrugInstruction,
  Model<ITaminDrugInstruction>
>({
  drugInstId: { type: String },
  drugInstCode: { type: String },
  drugInstSumry: { type: String },
  drugInstLatin: { type: String },
  drugInstConcept: { type: String },
});

const TaminDrugInstruction = mongoose.model(
  "TaminDrugInstruction",
  TaminDrugInstructionSchema
);

export default TaminDrugInstruction;
