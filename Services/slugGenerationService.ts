import mongoose from "mongoose";
import slugify from "../Lib/slug";

import Insurance from "../Models/Insurance";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Paraclinic from "../Models/Paraclinic";
import Test from "../Models/Test";
import ServicePackage from "../Models/ServicePackage";
import Service from "../Models/Service";
import ProductPackage from "../Models/ProductPackage";
import Product from "../Models/Product";
import Pharmacy from "../Models/Pharmacy";
import DoctorProfile from "../Models/DoctorProfile";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import SymptomCategory from "../Models/SymptomCategory";
import Disease from "../Models/Disease";
import Speciality from "../Models/Speciality";
import SpecialityCategory from "../Models/SpecialityCategory";
import ServiceCategory from "../Models/ServiceCategory";
import TestCategory from "../Models/TestCategory";
import HospitalCategory from "../Models/HospitalCategory";
import ClinicCategory from "../Models/ClinicCategory";
import DiseaseCategory from "../Models/DiseaseCategory";
import Doctor from "../Models/Doctor";
import BlogCategory from "../Models/BlogCategory";
import FaqCategory from "../Models/FaqCategory";
import InsuranceCategory from "../Models/InsuranceCategory";
import Blog from "../Models/Blog";

// Only fields that some model in the list below might use as its slug
// source. Selecting this fixed superset (instead of per-model select)
// keeps this file simple; unused fields are just ignored per document.
const SOURCE_FIELDS_SELECT = "_id slug name title firstName lastName";

type SlugSourceConfig = {
  model: mongoose.Model<any>;
  // Builds the text a slug should be generated from, for a given document.
  getSourceText: (doc: any) => string | undefined;
};

const byField =
  (field: string) =>
  (doc: any): string | undefined =>
    doc[field];

// Note: PageMeta also has a `slug` field, but it's a pointer to the slug of
// another resource (see Models/PageMeta.ts) rather than something to derive
// from PageMeta's own title, so it's intentionally left out of this list.
const SLUG_SOURCE_CONFIGS: SlugSourceConfig[] = [
  { model: Insurance, getSourceText: byField("name") },
  { model: Clinic, getSourceText: byField("name") },
  { model: Hospital, getSourceText: byField("name") },
  { model: Paraclinic, getSourceText: byField("name") },
  { model: Test, getSourceText: byField("name") },
  { model: ServicePackage, getSourceText: byField("name") },
  { model: Service, getSourceText: byField("name") },
  { model: ProductPackage, getSourceText: byField("name") },
  { model: Product, getSourceText: byField("name") },
  { model: Pharmacy, getSourceText: byField("name") },
  {
    model: DoctorProfile,
    getSourceText: (doc) =>
      [doc.firstName, doc.lastName].filter(Boolean).join(" ") || undefined,
  },
  { model: Drug, getSourceText: byField("name") },
  { model: Symptom, getSourceText: byField("name") },
  { model: SymptomCategory, getSourceText: byField("name") },
  { model: Disease, getSourceText: byField("name") },
  { model: Speciality, getSourceText: byField("name") },
  { model: SpecialityCategory, getSourceText: byField("name") },
  { model: ServiceCategory, getSourceText: byField("title") },
  { model: TestCategory, getSourceText: byField("name") },
  { model: HospitalCategory, getSourceText: byField("name") },
  { model: ClinicCategory, getSourceText: byField("name") },
  { model: DiseaseCategory, getSourceText: byField("name") },
  { model: Doctor, getSourceText: byField("name") },
  { model: BlogCategory, getSourceText: byField("title") },
  { model: FaqCategory, getSourceText: byField("name") },
  { model: InsuranceCategory, getSourceText: byField("name") },
  { model: Blog, getSourceText: byField("title") },
];

const MISSING_SLUG_FILTER = {
  $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }],
};

// Cap how many documents a single run handles per model, so one very large
// backlog can't block the event loop for too long. Any leftovers are picked
// up on the next tick.
const MAX_DOCS_PER_MODEL_PER_RUN = 500;

// Appends a numeric suffix until the slug no longer collides with another
// document in the same collection (slug fields are typically unique+sparse).
const uniqueSlugFor = async (
  model: mongoose.Model<any>,
  baseSlug: string,
  excludeId: mongoose.Types.ObjectId,
): Promise<string> => {
  let candidate = baseSlug;
  let attempt = 1;
  while (await model.exists({ slug: candidate, _id: { $ne: excludeId } })) {
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
  return candidate;
};

const generateSlugsForModel = async ({
  model,
  getSourceText,
}: SlugSourceConfig): Promise<number> => {
  const docs = await model
    .find(MISSING_SLUG_FILTER)
    .select(SOURCE_FIELDS_SELECT)
    .limit(MAX_DOCS_PER_MODEL_PER_RUN);

  let updated = 0;

  for (const doc of docs) {
    const sourceText = getSourceText(doc);
    // Fall back to the document id so we never leave a document unslugged
    // just because it has no title/name yet.
    const baseSlug = slugify(sourceText) || doc._id.toString();
    const slug = await uniqueSlugFor(model, baseSlug, doc._id);

    await model.updateOne({ _id: doc._id }, { $set: { slug } });
    updated += 1;
  }

  return updated;
};

export const generateMissingSlugs = async (): Promise<void> => {
  for (const config of SLUG_SOURCE_CONFIGS) {
    try {
      const updated = await generateSlugsForModel(config);
      if (updated > 0) {
        console.log(
          `[slugGeneration] ${config.model.modelName}: generated ${updated} slug(s)`,
        );
      }
    } catch (err) {
      console.log(`[slugGeneration] ${config.model.modelName}: failed`);
      console.log(err);
    }
  }
};

export const startSlugGenerationJob = (intervalMs: number): void => {
  setInterval(() => {
    generateMissingSlugs().catch(console.error);
  }, intervalMs);
};
