import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IFaq extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
  isHome: boolean;
  question?: string;
  answer?: string;
}

const FaqSchema = new mongoose.Schema<IFaq, Model<IFaq>>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  isHome: { type: Boolean, default: false },
  question: { type: String },
  answer: { type: String },
});

const Faq = mongoose.model("Faq", FaqSchema);

export default Faq;
