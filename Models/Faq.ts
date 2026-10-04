import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IFaqCategory } from "./FaqCategory";

export interface IFaq extends MongoDoc {
  name?: string;
  isActive: boolean;
  order: number;
  isHome: boolean;
  question?: string;
  answer?: string;
  category?: IFaqCategory;
}

const FaqSchema = new mongoose.Schema<IFaq, Model<IFaq>>({
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  isHome: { type: Boolean, default: false },
  // a question with no text or no answer can't be published
  question: { type: String, trim: true, required: true },
  answer: { type: String, trim: true, required: true },
  category: { type: mongoose.Schema.ObjectId, ref: "FaqCategory" },
});

FaqSchema.plugin(translatable);

const Faq = mongoose.model("Faq", FaqSchema);

export default Faq;
