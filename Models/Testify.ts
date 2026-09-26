import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITestify extends MongoDoc {
  name?: string;
  image?: string;
  title?: string;
  content?: string;
  isActive: boolean;
  order: number;
}

const TestifySchema = new mongoose.Schema<ITestify, Model<ITestify>>({
  name: { type: String },
  image: { type: String },
  title: { type: String },
  content: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

TestifySchema.plugin(translatable);

const Testify = mongoose.model("Testify", TestifySchema);

export default Testify;
