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
}

const TestSchema = new mongoose.Schema<ITest, Model<ITest>>({
  name: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  slug: { type: String },
  category: { type: mongoose.Schema.ObjectId, ref: "TestCategory" },
  summary: { type: String },
});

const Test = mongoose.model("Test", TestSchema);

export default Test;
