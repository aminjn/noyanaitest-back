import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IDoctorFaq extends MongoDoc {
  doctor?: IDoctorProfile;
  question: string;
  answer: string;
  active: boolean;
  order: number;
}

const DoctorFaqSchema = new mongoose.Schema<IDoctorFaq, Model<IDoctorFaq>>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
  },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  active: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

const DoctorFaq = mongoose.model("DoctorFaq", DoctorFaqSchema);

export default DoctorFaq;
