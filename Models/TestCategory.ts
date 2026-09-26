import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITestCategory extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
  slug?: string;
}

const TestCategorySchema = new mongoose.Schema<
  ITestCategory,
  Model<ITestCategory>
>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  slug: { type: String },
});

TestCategorySchema.plugin(translatable);

const TestCategory = mongoose.model("TestCategory", TestCategorySchema);

export default TestCategory;
