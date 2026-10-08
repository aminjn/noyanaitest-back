import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITestCategory } from "./TestCategory";

export interface ITest extends MongoDoc {
  name?: string;
  order: number;
  isActive: boolean;
  slug?: string;
  category?: ITestCategory;
  summary?: string;
  // the public test page (2026-10, /test/<slug>): what the test measures
  // and how to prepare (fasting, medicines to pause), as Labtests / Practo
  // show above the labs that offer it
  description?: string;
  preparation?: string;
}

const TestSchema = new mongoose.Schema<ITest, Model<ITest>>({
  name: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  slug: { type: String, unique: true, sparse: true },
  category: { type: mongoose.Schema.ObjectId, ref: "TestCategory" },
  summary: { type: String },
  description: { type: String },
  preparation: { type: String },
});

TestSchema.plugin(translatable);

const Test = mongoose.model("Test", TestSchema);

export default Test;
