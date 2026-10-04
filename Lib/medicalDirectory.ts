import mongoose, { isValidObjectId } from "mongoose";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import Part from "../Models/Part";
import Speciality from "../Models/Speciality";
import DiseaseCategory from "../Models/DiseaseCategory";
import SymptomCategory from "../Models/SymptomCategory";
import DrugTag from "../Models/Drugtag";
import { drugPrescriptionStatuses } from "../Models/Drug";
import { PUBLIC_MEDICAL } from "./medicalContent";
import { Locale, SOURCE_LOCALE } from "./locales";
import { directoryCache as cache } from "./directoryCache";

// The medical directory (2026-10, owner's decision): diseases, drugs and
// symptoms browsable the Mayo Clinic / WebMD / Drugs.com / Altibbi way -
// A to Z, by body part, by speciality, by category, by therapeutic class,
// Rx / OTC - each state its own crawlable URL that leads the visitor on to
// the AI symptom check or to a doctor. Only published records and active
// taxonomies are listed. Used by Controllers/directoryController (pages,
// sitemap) and Lib/seo/seoResolver (titles, structured data).

export const directoryKinds = ["disease", "drug", "symptom"] as const;
export type DirectoryKind = (typeof directoryKinds)[number];

export const directoryFacetTypes = {
  disease: ["letter", "part", "speciality", "category"],
  drug: ["letter", "class", "status"],
  symptom: ["letter", "part", "category"],
} as const satisfies Record<DirectoryKind, readonly string[]>;

export type DirectoryFacetType =
  (typeof directoryFacetTypes)[DirectoryKind][number];

export const isDirectoryKind = (v: unknown): v is DirectoryKind =>
  (directoryKinds as readonly unknown[]).includes(v);

export const isFacetOf = (kind: DirectoryKind, type: unknown): type is DirectoryFacetType =>
  (directoryFacetTypes[kind] as readonly unknown[]).includes(type);

export const directoryModels: Record<DirectoryKind, mongoose.Model<any>> = {
  disease: Disease,
  drug: Drug,
  symptom: Symptom,
};

// the page URL of a facet value, e.g. /disease/part/heart, /drug/status/rx
export const facetPath = (kind: DirectoryKind, type: DirectoryFacetType, value: string) =>
  `/${kind}/${type}/${value}`;

// ---------------------------------------------------------------- letters

// One letter of the index stands for its spelling variants: Arabic-typed
// ي / ك, hamza forms of alef, ة for ه. آ keeps its own entry, the way
// Persian dictionaries and Altibbi's index list it.
const LETTER_VARIANTS: Record<string, string> = {
  ا: "اأإٱ",
  ی: "یيىئ",
  ک: "کك",
  ه: "هةۀ",
  و: "وؤ",
};
const VARIANT_TO_LETTER: Record<string, string> = Object.fromEntries(
  Object.entries(LETTER_VARIANTS).flatMap(([letter, all]) =>
    Array.from(all).map((c) => [c, letter]),
  ),
);

// the index entry a name is filed under ("" = not a letter: digits, marks)
export const canonicalLetter = (raw: string): string => {
  const c = Array.from((raw || "").trim())[0] || "";
  if (!c || !/\p{L}/u.test(c)) return "";
  return VARIANT_TO_LETTER[c] || c.toLocaleUpperCase("en");
};

const escapeClass = (s: string) => s.replace(/[\]\\^-]/g, "\\$&");

const letterRegex = (letter: string) => {
  const chars = LETTER_VARIANTS[letter] || letter;
  const lower = chars.toLocaleLowerCase("en");
  const all = Array.from(new Set(Array.from(chars + lower))).join("");
  return new RegExp(`^\\s*[${escapeClass(all)}]`);
};

// a record is filed under the letter of the name the visitor sees: its
// translation in that language, else the Persian name
const translatedName = (locale: Locale) => `translations.${locale}.name`;
export const letterFilter = (letter: string, locale: Locale): Record<string, unknown> => {
  const re = letterRegex(letter);
  if (locale === SOURCE_LOCALE) return { name: re };
  const t = translatedName(locale);
  return {
    $or: [
      { [t]: re },
      { $and: [{ $or: [{ [t]: { $exists: false } }, { [t]: null }, { [t]: "" }] }, { name: re }] },
    ],
  };
};

// the visible name in aggregations (same rule as above)
export const displayNameExpr = (locale: Locale) =>
  locale === SOURCE_LOCALE
    ? "$name"
    : {
        $let: {
          vars: { t: `$${translatedName(locale)}` },
          in: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: "$$t" }, "string"] },
                  { $gt: [{ $strLenCP: { $trim: { input: "$$t" } } }, 0] },
                ],
              },
              "$$t",
              "$name",
            ],
          },
        },
      };

// ---------------------------------------------------------------- cache

const CACHE_MS = 5 * 60 * 1000;
const cached = async <T>(key: string, make: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await make();
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
};

// which letters have entries, in this language: [{ letter, count }]
export const directoryLetters = (kind: DirectoryKind, locale: Locale) =>
  cached(`letters|${kind}|${locale}`, async () => {
    const rows: { _id: string; n: number }[] = await directoryModels[kind].aggregate([
      { $match: { ...PUBLIC_MEDICAL } },
      { $project: { c: { $substrCP: [{ $trim: { input: { $ifNull: [displayNameExpr(locale), ""] } } }, 0, 1] } } },
      { $group: { _id: "$c", n: { $sum: 1 } } },
    ]);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const letter = canonicalLetter(row._id || "");
      if (letter) counts.set(letter, (counts.get(letter) || 0) + row.n);
    }
    return Array.from(counts, ([letter, count]) => ({ letter, count }));
  });

// ---------------------------------------------------------------- facets

type FacetRow = {
  _id: string;
  name?: string;
  slug?: string;
  region?: string;
  translations?: unknown;
  count: number;
};

const countBy = async (kind: DirectoryKind, field: string) => {
  const rows: { _id: mongoose.Types.ObjectId | string | null; n: number }[] =
    await directoryModels[kind].aggregate([
      { $match: { ...PUBLIC_MEDICAL } },
      { $unwind: `$${field}` },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ]);
  return new Map(rows.filter((r) => r._id).map((r) => [String(r._id), r.n]));
};

const withCounts = async (
  model: mongoose.Model<any>,
  counts: Map<string, number>,
  active: Record<string, unknown>,
  select = "name slug translations order",
): Promise<FacetRow[]> => {
  if (!counts.size) return [];
  const docs = await model
    .find({ _id: { $in: Array.from(counts.keys()) }, ...active })
    .select(select)
    .sort({ order: 1, _id: 1 })
    .lean<Record<string, any>[]>();
  return docs.map((d) => ({
    _id: String(d._id),
    name: d.name,
    slug: d.slug,
    ...(d.region ? { region: d.region } : {}),
    ...(d.translations ? { translations: d.translations } : {}),
    count: counts.get(String(d._id)) || 0,
  }));
};

const ACTIVE_PART = { isActive: { $ne: false } };

// public diseases per body part: their own parts plus their symptoms' parts
const diseasePartCounts = async () => {
  const [diseases, symptoms] = await Promise.all([
    Disease.find({ ...PUBLIC_MEDICAL }).select("parts symptoms").lean<{ _id: unknown; parts?: unknown[]; symptoms?: unknown[] }[]>(),
    Symptom.find({ ...PUBLIC_MEDICAL, "part.0": { $exists: true } }).select("part").lean<{ _id: unknown; part?: unknown[] }[]>(),
  ]);
  const symptomParts = new Map(symptoms.map((s) => [String(s._id), (s.part || []).map(String)]));
  const counts = new Map<string, number>();
  for (const d of diseases) {
    const parts = new Set<string>((d.parts || []).map(String));
    for (const s of d.symptoms || []) for (const p of symptomParts.get(String(s)) || []) parts.add(p);
    for (const p of parts) counts.set(p, (counts.get(p) || 0) + 1);
  }
  return counts;
};

export type DirectoryFacets = Partial<{
  parts: FacetRow[];
  specialities: FacetRow[];
  categories: FacetRow[];
  classes: FacetRow[];
  statuses: { value: string; count: number }[];
}>;

// every facet value of a kind that lists at least one public record
export const directoryFacets = (kind: DirectoryKind) =>
  cached<DirectoryFacets>(`facets|${kind}`, async () => {
    if (kind === "disease") {
      const [parts, specialities, categories] = await Promise.all([
        diseasePartCounts().then((c) => withCounts(Part, c, ACTIVE_PART, "name slug region translations order")),
        countBy("disease", "specialities").then((c) => withCounts(Speciality, c, { active: true })),
        countBy("disease", "category").then((c) => withCounts(DiseaseCategory, c, { isActive: true })),
      ]);
      return { parts, specialities, categories };
    }
    if (kind === "drug") {
      const [classes, statusRows] = await Promise.all([
        countBy("drug", "tag").then((c) => withCounts(DrugTag, c, { isActive: true })),
        countBy("drug", "prescriptionStatus"),
      ]);
      const statuses = drugPrescriptionStatuses
        .map((value) => ({ value, count: statusRows.get(value) || 0 }))
        .filter((s) => s.count > 0);
      return { classes, statuses };
    }
    const [parts, categories] = await Promise.all([
      countBy("symptom", "part").then((c) => withCounts(Part, c, ACTIVE_PART, "name slug region translations order")),
      countBy("symptom", "category").then((c) => withCounts(SymptomCategory, c, { isActive: true })),
    ]);
    return { parts, categories };
  });

// ---------------------------------------------------------------- one facet

export type ResolvedFacet = {
  type: DirectoryFacetType;
  // canonical value in the URL (a letter, a slug, rx / otc)
  value: string;
  // the taxonomy record (localized by the response), when there is one
  node?: { _id: string; name?: string; slug?: string; translations?: unknown };
  filter: Record<string, unknown>;
  // the speciality to book with, when the facet is one
  specialityId?: string;
};

const bySlugOrId = (value: string) =>
  isValidObjectId(value) ? { $or: [{ slug: value }, { _id: value }] } : { slug: value };

const nodeOf = (d: Record<string, any>) => ({
  _id: String(d._id),
  name: d.name,
  slug: d.slug,
  ...(d.translations ? { translations: d.translations } : {}),
});

// one facet value -> its filter; null when unknown or switched off (404)
export const resolveFacet = async (
  kind: DirectoryKind,
  type: DirectoryFacetType,
  rawValue: string,
  locale: Locale,
): Promise<ResolvedFacet | null> => {
  const value = (rawValue || "").trim();
  if (!value || value.length > 200) return null;
  if (type === "letter") {
    if (Array.from(value).length !== 1) return null;
    const letter = canonicalLetter(value);
    if (!letter) return null;
    return { type, value: letter, filter: letterFilter(letter, locale) };
  }
  if (type === "status") {
    if (kind !== "drug" || !(drugPrescriptionStatuses as readonly string[]).includes(value)) return null;
    return { type, value, filter: { prescriptionStatus: value } };
  }
  const find = async (model: mongoose.Model<any>, active: Record<string, unknown>, select = "name slug translations") =>
    model.findOne({ ...bySlugOrId(value), ...active }).select(select).lean<Record<string, any>>();
  if (type === "part") {
    const part = await find(Part, ACTIVE_PART);
    if (!part) return null;
    const filter =
      kind === "symptom"
        ? { part: part._id }
        : {
            $or: [
              { parts: part._id },
              {
                symptoms: {
                  $in: await Symptom.distinct("_id", { part: part._id, ...PUBLIC_MEDICAL }),
                },
              },
            ],
          };
    return { type, value: part.slug || String(part._id), node: nodeOf(part), filter };
  }
  if (type === "speciality") {
    if (kind !== "disease") return null;
    const spec = await find(Speciality, { active: true });
    if (!spec) return null;
    return {
      type,
      value: spec.slug || String(spec._id),
      node: nodeOf(spec),
      filter: { specialities: spec._id },
      specialityId: String(spec._id),
    };
  }
  if (type === "category") {
    const model = kind === "disease" ? DiseaseCategory : kind === "symptom" ? SymptomCategory : null;
    if (!model) return null;
    const cat = await find(model, { isActive: true });
    if (!cat) return null;
    return { type, value: cat.slug || String(cat._id), node: nodeOf(cat), filter: { category: cat._id } };
  }
  if (type === "class") {
    if (kind !== "drug") return null;
    const cls = await find(DrugTag, { isActive: true });
    if (!cls) return null;
    return { type, value: cls.slug || String(cls._id), node: nodeOf(cls), filter: { tag: cls._id } };
  }
  return null;
};

// ---------------------------------------------------------------- funnel

// The speciality a facet's visitor most likely needs - the one most of the
// listed diseases are treated by - for the «book a specialist» button.
export const funnelSpeciality = async (
  kind: DirectoryKind,
  filter: Record<string, unknown>,
  facet?: ResolvedFacet | null,
) => {
  let id = facet?.specialityId;
  if (!id) {
    let diseaseMatch: Record<string, unknown> = { ...filter, ...PUBLIC_MEDICAL };
    if (kind !== "disease") {
      const ids = (
        await directoryModels[kind]
          .find({ ...filter, ...PUBLIC_MEDICAL })
          .select("_id")
          .limit(500)
          .lean<{ _id: mongoose.Types.ObjectId }[]>()
      ).map((d) => d._id);
      if (!ids.length) return null;
      diseaseMatch = { [kind === "drug" ? "drugs" : "symptoms"]: { $in: ids }, ...PUBLIC_MEDICAL };
    }
    const rows: { _id: mongoose.Types.ObjectId }[] = await Disease.aggregate([
      { $match: diseaseMatch },
      { $unwind: "$specialities" },
      { $group: { _id: "$specialities", n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: 5 },
    ]);
    const active = await Speciality.find({ _id: { $in: rows.map((r) => r._id) }, active: true })
      .select("_id")
      .lean<{ _id: mongoose.Types.ObjectId }[]>();
    const ok = new Set(active.map((a) => String(a._id)));
    id = rows.map((r) => String(r._id)).find((r) => ok.has(r));
  }
  if (!id) return null;
  return Speciality.findOne({ _id: id, active: true }).select("name slug translations").lean();
};
