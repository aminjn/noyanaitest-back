import mongoose, { Model } from "mongoose";
import { locales, Locale } from "../Lib/locales";

// Admin edits to the UI texts, one document per language. The base texts
// ship with the frontend (Components/i18n/messages/<locale>.json); only keys
// changed from the admin dictionary are stored here, and they win over the
// file. Replaces the old single TextContent document (its Persian values are
// migrated into the "fa" document on first boot - Services/translationStore).
export interface ITranslation {
  locale: Locale;
  texts: Record<string, string>;
  updatedAt: Date;
}

const TranslationSchema = new mongoose.Schema<ITranslation, Model<ITranslation>>(
  {
    locale: { type: String, enum: locales, required: true, unique: true },
    texts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: { createdAt: false, updatedAt: true }, minimize: false },
);

const Translation = mongoose.model("Translation", TranslationSchema);

export default Translation;
