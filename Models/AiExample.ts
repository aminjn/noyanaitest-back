import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IAiExample extends MongoDoc {
  isActive: boolean;
  name: string;
  order: number;
  prompt: string;
  category: string;
}

const AiExampleSchema = new mongoose.Schema<IAiExample, Model<IAiExample>>({
  isActive: { type: Boolean, default: false },
  name: { type: String, required: true },
  order: { type: Number, default: 0 },
  prompt: { type: String },
  category: { type: String },
});

const AiExample = mongoose.model("AiExample", AiExampleSchema);

export default AiExample;
