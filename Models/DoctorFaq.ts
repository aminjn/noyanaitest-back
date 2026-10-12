import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IDoctorFaq extends MongoDoc {
  doctor?: IDoctorProfile;
  question: string;
  answer: string;
  active: boolean;
  order: number;
  archived?: boolean;
}

const DoctorFaqSchema = new mongoose.Schema<IDoctorFaq, Model<IDoctorFaq>>({
  // a doctor's own question (an archived shared one has none)
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: function (this: { archived?: boolean }) {
      return !this.archived;
    },
  },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  active: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  // A question with no doctor used to show on EVERY doctor's page (the
  // admin's «سوالات مشترک صفحه‌ی پزشکان»). That was a mistake the automatic
  // FAQ (Lib/autoFaq.ts) replaces (2026-10): those rows are archived
  // (Lib/migrateGlobalDoctorFaqs.ts) - kept, never shown, never created again.
  archived: { type: Boolean, default: false },
});


DoctorFaqSchema.plugin(translatable);

const DoctorFaq = mongoose.model("DoctorFaq", DoctorFaqSchema);

export default DoctorFaq;
