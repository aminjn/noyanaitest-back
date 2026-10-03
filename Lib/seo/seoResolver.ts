import { seoCache, clearSeoCache } from "./seoCache";
import { tomanToRial } from "../currency";
import mongoose from "mongoose";
import { currentLocale } from "../i18n/requestContext";
import { Locale } from "../locales";
import PageMeta from "../../Models/PageMeta";
import SeoTemplate from "../../Models/SeoTemplate";
import DoctorProfile from "../../Models/DoctorProfile";
import Clinic from "../../Models/Clinic";
import Hospital from "../../Models/Hospital";
import ParaClinic from "../../Models/Paraclinic";
import Pharmacy from "../../Models/Pharmacy";
import Insurance from "../../Models/Insurance";
import Drug from "../../Models/Drug";
import Disease from "../../Models/Disease";
import Symptom from "../../Models/Symptom";
import Speciality from "../../Models/Speciality";
import Service from "../../Models/Service";
import ServicePackage from "../../Models/ServicePackage";
import Product from "../../Models/Product";
import ProductPackage from "../../Models/ProductPackage";
import Blog from "../../Models/Blog";
import Test from "../../Models/Test";
import InPersonSettings from "../../Models/InPersonSettings";
import { SeoTemplateText, seoListDefaults, seoNodeDefaults } from "./seoDefaults";

// Automatic SEO for every public page (2026-10). Each page type has a
// template (the super admin's, else Lib/seo/seoDefaults.ts) filled from the
// record itself, so a new doctor, pharmacy or drug is described, given a
// canonical URL, an image and structured data (schema.org) the moment it is
// published - nobody writes SEO per record. A record's own SEO entry
// (PageMeta, «متادیتای صفحات») still wins field by field.
//
// Template syntax: {variable} is replaced; a [ ... ] part is dropped when a
// variable inside it is empty. URLs in the structured data use the tokens
// {{ORIGIN}} (the site) and {{FILES}} (uploaded files); the frontend, which
// knows both, replaces them.

type Lean = Record<string, any>;
type Vars = Record<string, string>;

const ORIGIN = "{{ORIGIN}}";
const FILES = "{{FILES}}";

// ---------------------------------------------------------------- text

const localized = (doc: Lean | null | undefined, field: string, locale: Locale): unknown => {
  if (!doc) return undefined;
  const t = doc.translations?.[locale]?.[field];
  if (typeof t === "string" ? t.trim() : Array.isArray(t) && t.length) return t;
  return doc[field];
};

// Slate RTF JSON, HTML or plain text -> one clean line
const slateText = (node: unknown): string => {
  if (!node) return "";
  if (Array.isArray(node)) return node.map(slateText).join(" ");
  if (typeof node === "object") {
    const n = node as { text?: unknown; children?: unknown };
    if (typeof n.text === "string") return n.text;
    return slateText(n.children);
  }
  return "";
};

export const plainText = (value: unknown, max = 0): string => {
  let text = "";
  if (typeof value === "string") {
    const raw = value.trim();
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        text = slateText(JSON.parse(raw));
      } catch {
        text = raw;
      }
    } else text = raw;
  } else if (Array.isArray(value)) text = value.filter((v) => typeof v === "string").join("، ");
  text = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (max && text.length > max) {
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[،,.;:\s]+$/, "")}…`;
  }
  return text;
};

const tidy = (text: string) =>
  text
    .replace(/\s+/g, " ")
    // "داروخانه {name}" with a name that already starts with it
    .replace(/(^|\s)(\S+)(?:\s+\2)+(?=\s|$|[،,.|])/g, "$1$2")
    .replace(/\s+([،,.:;!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/([،,|–\-:·])(\s*[،,|–\-:·])+/g, "$1")
    .replace(/^[\s،,|–\-:·]+|[\s،,|–\-:·]+$/g, "")
    .trim();

// fills a template; `strict` = any empty variable outside [ ] voids it
const fill = (template: string, vars: Vars, strict = false): string => {
  let missing = false;
  let out = template.replace(/\[([^[\]]*)\]/g, (_, inner: string) => {
    let empty = false;
    const part = inner.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = vars[key];
      if (!v) empty = true;
      return v || "";
    });
    return empty ? "" : part;
  });
  out = out.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    if (!v) missing = true;
    return v || "";
  });
  if (strict && missing) return "";
  return tidy(out);
};

const clampTitle = (title: string) => {
  if (title.length <= 70) return title;
  const bar = title.lastIndexOf(" | ");
  return bar > 20 ? title.slice(0, bar) : plainText(title, 70);
};

// ---------------------------------------------------------------- schema

const nameOf = (doc: Lean | null | undefined, locale: Locale) =>
  plainText(localized(doc, "name", locale) ?? localized(doc, "title", locale));

const fileUrl = (name?: unknown) =>
  typeof name === "string" && name ? (/^https?:\/\//.test(name) ? name : `${FILES}/${name}`) : undefined;

const postalAddress = (doc: Lean, locale: Locale) => {
  const street = plainText(localized(doc, "address", locale));
  const city = nameOf(doc.city, locale);
  const region = nameOf(doc.province, locale);
  if (!street && !city && !region) return undefined;
  return {
    "@type": "PostalAddress",
    ...(street && { streetAddress: street }),
    ...(city && { addressLocality: city }),
    ...(region && { addressRegion: region }),
    addressCountry: "IR",
  };
};

const geoOf = (doc: Lean) => {
  const c = doc.location?.coordinates;
  if (!Array.isArray(c) || c.length !== 2) return undefined;
  return { "@type": "GeoCoordinates", latitude: c[1], longitude: c[0] };
};

const ratingOf = (avg: unknown, count: unknown) => {
  const a = Number(avg);
  const n = Number(count);
  if (!(a > 0) || !(n > 0)) return undefined;
  return {
    "@type": "AggregateRating",
    ratingValue: Math.round(a * 10) / 10,
    reviewCount: n,
    bestRating: 5,
    worstRating: 1,
  };
};

// the cheapest live pharmacy offer of a product (price minus discount)
const lowestOffer = (doc: any): number | undefined => {
  const offers = (Array.isArray(doc?.sellers) ? doc.sellers : [])
    .map((o: any) => Number(o?.price || 0) - Number(o?.discount || 0))
    .filter((v: number) => v > 0);
  return offers.length ? Math.min(...offers) : undefined;
};

const offerOf = (toman: unknown) => {
  const p = Number(toman);
  if (!(p > 0)) return undefined;
  // schema.org wants an ISO currency: the rial
  return { "@type": "Offer", price: tomanToRial(p), priceCurrency: "IRR", availability: "https://schema.org/InStock" };
};

const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null));

// ---------------------------------------------------------------- pages

const geoPopulate = [
  { path: "province", select: "name translations" },
  { path: "city", select: "name translations" },
  { path: "district", select: "name translations" },
];

type NodeConfig = {
  model: mongoose.Model<any>;
  // what counts as public (same as the sitemap)
  visible: Record<string, unknown>;
  populate?: any[];
  // the list page this one belongs to, for the breadcrumb
  list: string;
  path: (slug: string) => string;
  vars: (doc: Lean, locale: Locale, fmt: Intl.NumberFormat) => Promise<Vars> | Vars;
  image?: (doc: Lean) => unknown;
  schema: (doc: Lean, base: Record<string, unknown>, locale: Locale) => Record<string, unknown>;
};

const num = (fmt: Intl.NumberFormat, v: unknown, cond = true) =>
  cond && Number(v) > 0 ? fmt.format(Number(v)) : "";

const placeVars = (doc: Lean, locale: Locale) => ({
  city: nameOf(doc.city, locale),
  province: nameOf(doc.province, locale),
  district: nameOf(doc.district, locale),
});

const orgSchema =
  (type: string) => (doc: Lean, base: Record<string, unknown>, locale: Locale) =>
    clean({
      ...base,
      "@type": type,
      telephone: plainText(doc.phone) || undefined,
      address: postalAddress(doc, locale),
      geo: geoOf(doc),
      openingHours: plainText(localized(doc, "businessTimes", locale) ?? localized(doc, "businessTime", locale)) || undefined,
      ...(doc.isRoundTheClock && { openingHours: "Mo-Su 00:00-23:59" }),
      aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      sameAs: typeof doc.website === "string" && /^https?:\/\//.test(doc.website) ? [doc.website] : undefined,
    });

const orgVars = (doc: Lean, locale: Locale, fmt: Intl.NumberFormat): Vars => ({
  name: nameOf(doc, locale),
  ...placeVars(doc, locale),
  phone: plainText(doc.phone),
  hours: plainText(localized(doc, "businessTimes", locale) ?? localized(doc, "businessTime", locale)),
  rating: Number(doc.commentCount) > 0 ? num(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), doc.averageScore) : "",
  reviews: num(fmt, doc.commentCount),
  category: nameOf(doc.category, locale),
  summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "description", locale), 110),
});

const nodeConfigs: Record<string, NodeConfig> = {
  "/dr/[slug]": {
    model: DoctorProfile,
    visible: { active: true },
    populate: [
      ...geoPopulate,
      { path: "mainSpeciality", select: "name slug translations" },
      { path: "specialities", select: "name translations" },
    ],
    list: "/doctors",
    path: (slug) => `/dr/${slug}`,
    vars: async (doc, locale, fmt) => {
      const settings = await InPersonSettings.findOne({ doctor: doc._id, active: true, price: { $gt: 0 } })
        .select("price")
        .lean<{ price?: number }>();
      return {
        name: plainText([localized(doc, "firstName", locale), localized(doc, "lastName", locale)].filter(Boolean).join(" ")),
        speciality: nameOf(doc.mainSpeciality, locale),
        specialities: (Array.isArray(doc.specialities) ? doc.specialities : [])
          .map((s: Lean) => nameOf(s, locale))
          .filter(Boolean)
          .join("، "),
        ...placeVars(doc, locale),
        rating: Number(doc.feedbackCount) > 0 ? num(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), doc.averageScore) : "",
        reviews: num(fmt, doc.feedbackCount),
        price: num(fmt, settings?.price),
        summary: plainText(localized(doc, "introduction", locale), 110),
      };
    },
    image: (doc) => doc.avatar,
    schema: (doc, base, locale) =>
      clean({
        ...base,
        "@type": "Physician",
        medicalSpecialty: nameOf(doc.mainSpeciality, locale) || undefined,
        telephone: plainText(doc.landLine) || undefined,
        address: postalAddress(doc, locale),
        geo: geoOf(doc),
        aggregateRating: ratingOf(doc.averageScore, doc.feedbackCount),
        identifier: plainText(doc.medicalSystemCode) || undefined,
      }),
  },
  "/clinic/[slug]": {
    model: Clinic,
    visible: { active: true },
    populate: [...geoPopulate, { path: "category", select: "name translations" }],
    list: "/clinic",
    path: (slug) => `/clinic/${slug}`,
    vars: orgVars,
    image: (doc) => doc.image,
    schema: orgSchema("MedicalClinic"),
  },
  "/hospital/[slug]": {
    model: Hospital,
    visible: { isActive: true },
    populate: [...geoPopulate, { path: "category", select: "name translations" }],
    list: "/hospital",
    path: (slug) => `/hospital/${slug}`,
    vars: orgVars,
    image: (doc) => doc.image,
    schema: orgSchema("Hospital"),
  },
  "/paraClinic/[slug]": {
    model: ParaClinic,
    visible: { active: true },
    populate: [...geoPopulate, { path: "category", select: "name translations" }],
    list: "/paraClinic",
    path: (slug) => `/paraClinic/${slug}`,
    vars: orgVars,
    image: (doc) => doc.image,
    schema: orgSchema("DiagnosticLab"),
  },
  "/pharmacy/[slug]": {
    model: Pharmacy,
    visible: { active: true },
    populate: geoPopulate,
    list: "/product",
    path: (slug) => `/pharmacy/${slug}`,
    vars: orgVars,
    image: (doc) => doc.avatar || doc.banner,
    schema: orgSchema("Pharmacy"),
  },
  "/insurance/[slug]": {
    model: Insurance,
    visible: { active: true },
    populate: [{ path: "category", select: "name translations" }],
    list: "/insurance",
    path: (slug) => `/insurance/${slug}`,
    vars: orgVars,
    image: (doc) => doc.image,
    schema: orgSchema("InsuranceAgency"),
  },
  "/drug/[slug]": {
    model: Drug,
    visible: {},
    list: "/drug",
    path: (slug) => `/drug/${slug}`,
    vars: (doc, locale) => ({
      name: nameOf(doc, locale),
      alternateName: plainText(localized(doc, "alternateName", locale)),
      ingredient: plainText(localized(doc, "activeIngridient", locale)),
      form: plainText(localized(doc, "dosageForm", locale)),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "aiSummary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base, locale) =>
      clean({
        ...base,
        "@type": "Drug",
        alternateName: plainText(localized(doc, "alternateName", locale)) || undefined,
        activeIngredient: plainText(localized(doc, "activeIngridient", locale)) || undefined,
        dosageForm: plainText(localized(doc, "dosageForm", locale)) || undefined,
        aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      }),
  },
  "/disease/[slug]": {
    model: Disease,
    visible: {},
    list: "/disease",
    path: (slug) => `/disease/${slug}`,
    vars: (doc, locale) => ({
      name: nameOf(doc, locale),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "aiSummary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (_doc, base) => clean({ ...base, "@type": "MedicalCondition" }),
  },
  "/symptom/[slug]": {
    model: Symptom,
    visible: {},
    list: "/symptom",
    path: (slug) => `/symptom/${slug}`,
    vars: (doc, locale) => ({
      name: nameOf(doc, locale),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "aiSummary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (_doc, base) => clean({ ...base, "@type": "MedicalSignOrSymptom" }),
  },
  "/speciality/[slug]": {
    model: Speciality,
    visible: { active: true },
    list: "/speciality",
    path: (slug) => `/speciality/${slug}`,
    vars: async (doc, locale, fmt) => ({
      name: nameOf(doc, locale),
      count: num(
        fmt,
        await DoctorProfile.countDocuments({
          active: true,
          $or: [{ mainSpeciality: doc._id }, { specialities: doc._id }],
        }),
      ),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base, locale) =>
      clean({ ...base, "@type": "MedicalWebPage", specialty: nameOf(doc, locale) || undefined }),
  },
  "/service/[slug]": {
    model: Service,
    visible: { isActive: true },
    populate: [{ path: "owner", select: "firstName lastName slug translations" }],
    list: "/service",
    path: (slug) => `/service/${slug}`,
    vars: (doc, locale, fmt) => ({
      name: nameOf(doc, locale),
      provider: plainText([localized(doc.owner, "firstName", locale), localized(doc.owner, "lastName", locale)].filter(Boolean).join(" ")),
      price: num(fmt, Number(doc.price || 0) - Number(doc.discount || 0)),
      summary: plainText(localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base) =>
      clean({
        ...base,
        "@type": "Service",
        offers: offerOf(Number(doc.price || 0) - Number(doc.discount || 0)),
        aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      }),
  },
  "/servicePackage/[slug]": {
    model: ServicePackage,
    visible: { isActive: true },
    populate: [{ path: "owner", select: "firstName lastName slug translations" }],
    list: "/service",
    path: (slug) => `/servicePackage/${slug}`,
    vars: (doc, locale, fmt) => ({
      name: nameOf(doc, locale),
      provider: plainText([localized(doc.owner, "firstName", locale), localized(doc.owner, "lastName", locale)].filter(Boolean).join(" ")),
      price: num(fmt, Number(doc.price || 0) - Number(doc.discount || 0)),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base) =>
      clean({
        ...base,
        "@type": "Service",
        offers: offerOf(Number(doc.price || 0) - Number(doc.discount || 0)),
        aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      }),
  },
  "/product/[slug]": {
    model: Product,
    visible: { isActive: true },
    // the price is the pharmacies' offers, the lowest live one ("from"),
    // never the catalog's base price, which nobody is charged
    populate: [{ path: "sellers", match: { isActive: true }, select: "price discount" }],
    list: "/product",
    path: (slug) => `/product/${slug}`,
    vars: (doc, locale, fmt) => ({
      name: nameOf(doc, locale),
      price: num(fmt, lowestOffer(doc)),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base) =>
      clean({
        ...base,
        "@type": "Product",
        offers: offerOf(lowestOffer(doc)),
        aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      }),
  },
  "/productPackage/[slug]": {
    model: ProductPackage,
    visible: { isActive: true },
    populate: [{ path: "owner", select: "name slug translations" }],
    list: "/product",
    path: (slug) => `/productPackage/${slug}`,
    vars: (doc, locale, fmt) => ({
      name: nameOf(doc, locale),
      provider: nameOf(doc.owner, locale),
      price: num(fmt, Number(doc.price || 0) - Number(doc.discount || 0)),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "description", locale), 110),
    }),
    image: (doc) => doc.image,
    schema: (doc, base) =>
      clean({
        ...base,
        "@type": "Product",
        offers: offerOf(Number(doc.price || 0) - Number(doc.discount || 0)),
        aggregateRating: ratingOf(doc.averageScore, doc.commentCount),
      }),
  },
  "/mag/[blogSlug]": {
    model: Blog,
    visible: { published: true },
    populate: [{ path: "category", select: "title translations" }],
    list: "/mag",
    path: (slug) => `/mag/${slug}`,
    vars: (doc, locale) => ({
      name: plainText(localized(doc, "title", locale), 90),
      summary: plainText(localized(doc, "summary", locale) ?? localized(doc, "content", locale), 155),
      category: plainText(localized(doc.category, "title", locale)),
    }),
    image: (doc) => doc.image,
    schema: (doc, base, locale) =>
      clean({
        ...base,
        "@type": "Article",
        headline: plainText(localized(doc, "title", locale), 110),
        datePublished: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : undefined,
        author: plainText(localized(doc, "author", locale))
          ? { "@type": "Person", name: plainText(localized(doc, "author", locale)) }
          : undefined,
      }),
  },
};

// listing pages that count what they list
const listCounts: Record<string, { model: mongoose.Model<any>; filter: Record<string, unknown> }> = {
  "/doctors": { model: DoctorProfile, filter: { active: true } },
  "/speciality": { model: Speciality, filter: { active: true } },
  "/clinic": { model: Clinic, filter: { active: true } },
  "/hospital": { model: Hospital, filter: { isActive: true } },
  "/paraClinic": { model: ParaClinic, filter: { active: true } },
  "/insurance": { model: Insurance, filter: { active: true } },
  "/drug": { model: Drug, filter: {} },
  "/disease": { model: Disease, filter: {} },
  "/symptom": { model: Symptom, filter: {} },
  "/product": { model: Product, filter: { isActive: true } },
  "/service": { model: Service, filter: { isActive: true } },
  "/test": { model: Test, filter: { isActive: true } },
  "/mag": { model: Blog, filter: { published: true } },
};

export const seoNodeTypes = Object.keys(nodeConfigs);

// the variables each page type offers (for the admin's legend)
export const seoVariables: Record<string, string[]> = {
  "/dr/[slug]": ["name", "speciality", "specialities", "city", "province", "district", "rating", "reviews", "price", "summary"],
  "/clinic/[slug]": ["name", "city", "province", "district", "phone", "hours", "rating", "reviews", "category", "summary"],
  "/hospital/[slug]": ["name", "city", "province", "district", "phone", "hours", "rating", "reviews", "category", "summary"],
  "/paraClinic/[slug]": ["name", "city", "province", "district", "phone", "hours", "rating", "reviews", "category", "summary"],
  "/pharmacy/[slug]": ["name", "city", "province", "district", "phone", "hours", "summary"],
  "/insurance/[slug]": ["name", "phone", "rating", "reviews", "category", "summary"],
  "/drug/[slug]": ["name", "alternateName", "ingredient", "form", "summary"],
  "/disease/[slug]": ["name", "summary"],
  "/symptom/[slug]": ["name", "summary"],
  "/speciality/[slug]": ["name", "count", "summary"],
  "/service/[slug]": ["name", "provider", "price", "summary"],
  "/servicePackage/[slug]": ["name", "provider", "price", "summary"],
  "/product/[slug]": ["name", "price", "summary"],
  "/productPackage/[slug]": ["name", "provider", "price", "summary"],
  "/mag/[blogSlug]": ["name", "summary", "category"],
};
for (const path of Object.keys(seoListDefaults)) seoVariables[path] = listCounts[path] ? ["count"] : [];

export const isSeoPageType = (path: string) => !!nodeConfigs[path] || !!seoListDefaults[path];

// ---------------------------------------------------------------- templates

const builtIn = (path: string, locale: Locale): SeoTemplateText | null => {
  const set = seoNodeDefaults[path] || seoListDefaults[path];
  if (!set) return null;
  return (set as Record<string, SeoTemplateText | undefined>)[locale] || set.en || set.fa;
};

export const defaultTemplate = (path: string, locale: Locale) => builtIn(path, locale);

const templateFor = async (path: string, locale: Locale) => {
  const saved = await SeoTemplate.findOne({ resourceType: path }).lean<Lean>();
  const fallback = builtIn(path, locale);
  const pick = (field: string) => {
    const v = localized(saved, field, locale);
    return (typeof v === "string" ? v.trim() : Array.isArray(v) && v.length) ? v : undefined;
  };
  return {
    title: (pick("title") as string) || fallback?.title || "{name}",
    description: (pick("description") as string) || fallback?.description || "[{summary}]",
    keywords: (pick("keywords") as string[]) || fallback?.keywords || [],
    noIndex: !!saved?.noIndex,
    custom: !!saved,
  };
};

// ---------------------------------------------------------------- cache

const CACHE_MS = 5 * 60 * 1000;
const cache = seoCache as Map<string, { at: number; value: ResolvedSeo | null }>;
export { clearSeoCache };

// ---------------------------------------------------------------- resolve

export type ResolvedSeo = {
  title?: string;
  description?: string;
  keywords: string[];
  ogTitle?: string;
  ogDescription?: string;
  image?: string;
  canonical: string;
  noIndex: boolean;
  noFollow: boolean;
  schema: Record<string, unknown>[];
  vars?: Vars;
  template?: { custom: boolean };
  override?: boolean;
};

const homeLabel: Partial<Record<Locale, string>> = { fa: "خانه", ar: "الرئيسية", ur: "ہوم", en: "Home" };

const breadcrumb = (items: { name: string; path: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items
    .filter((i) => i.name)
    .map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.name, item: `${ORIGIN}${i.path}` })),
});

const listName = async (path: string, locale: Locale) => {
  const t = await templateFor(path, locale);
  return plainText(fill(t.title, {}).split(" | ")[0], 60);
};

const overrideFrom = (meta: Lean | null, locale: Locale) => {
  if (!meta) return {};
  const s = (f: string) => {
    const v = localized(meta, f, locale);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const kw = localized(meta, "keywords", locale);
  return {
    title: s("title"),
    description: s("description"),
    keywords: Array.isArray(kw) && kw.length ? (kw as string[]) : undefined,
    ogTitle: s("ogTitle"),
    ogDescription: s("ogDescription"),
    image: fileUrl(meta.ogImage),
    canonical: s("canonicalUrl"),
    webSchema: meta.webSchema && typeof meta.webSchema === "object" ? meta.webSchema : undefined,
    noIndex: !!meta.noIndex,
    noFollow: !!meta.noFollow,
  };
};

const assemble = (
  t: { title: string; description: string; keywords: string[]; noIndex: boolean; custom: boolean },
  vars: Vars,
  o: ReturnType<typeof overrideFrom>,
  canonical: string,
  image: string | undefined,
  schema: Record<string, unknown>[],
  withVars: boolean,
): ResolvedSeo => {
  // a record with no name gets no generated title (the page names itself)
  const named = !("name" in vars) || !!vars.name;
  const title = o.title || (named ? clampTitle(fill(t.title, vars)) : "") || undefined;
  const description = o.description || plainText(fill(t.description, vars), 160) || undefined;
  const keywords =
    o.keywords ||
    Array.from(new Set(t.keywords.map((k) => fill(k, vars, true)).filter(Boolean))).slice(0, 12);
  return {
    title,
    description,
    keywords,
    ogTitle: o.ogTitle || title,
    ogDescription: o.ogDescription || description,
    image: o.image || image,
    canonical: o.canonical || canonical,
    noIndex: !!o.noIndex || t.noIndex,
    noFollow: !!o.noFollow,
    schema: o.webSchema ? [o.webSchema as Record<string, unknown>, ...schema.slice(1)] : schema,
    ...(withVars && { vars, template: { custom: t.custom }, override: !!(o.title || o.description) }),
  };
};

export const resolveSeo = async (
  path: string,
  slug?: string,
  opts: { withVars?: boolean; locale?: Locale } = {},
): Promise<ResolvedSeo | null> => {
  const locale = opts.locale || currentLocale();
  const key = `${locale}|${path}|${slug || ""}|${opts.withVars ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await compute(path, slug, locale, !!opts.withVars);
  if (cache.size > 3000) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
};

const compute = async (path: string, slug: string | undefined, locale: Locale, withVars: boolean) => {
  const fmt = new Intl.NumberFormat(locale);
  const node = nodeConfigs[path];
  if (node) {
    if (!slug) return null;
    let q = node.model.findOne({ slug });
    for (const p of node.populate || []) q = q.populate(p);
    const doc = (await q.lean()) as Lean | null;
    if (!doc) return null;
    const visible = await node.model.exists({ _id: doc._id, ...node.visible });
    const [t, vars, metaDoc] = await Promise.all([
      templateFor(path, locale),
      Promise.resolve(node.vars(doc, locale, fmt)),
      PageMeta.findOne({ resourceType: path, slug }).lean<Lean>(),
    ]);
    const o = overrideFrom(metaDoc, locale);
    const canonical = node.path(doc.slug || slug);
    const image = fileUrl(node.image?.(doc));
    const pageName = vars.name || nameOf(doc, locale);
    const main = node.schema(
      doc,
      clean({
        "@context": "https://schema.org",
        "@id": `${ORIGIN}${canonical}#main`,
        name: pageName || undefined,
        url: `${ORIGIN}${canonical}`,
        image,
        description: vars.summary || undefined,
      }),
      locale,
    );
    const crumbs = breadcrumb([
      { name: homeLabel[locale] || homeLabel.en || "", path: "/" },
      { name: await listName(node.list, locale), path: node.list },
      { name: pageName, path: canonical },
    ]);
    const resolved = assemble(t, vars, o, canonical, image, [main, crumbs], withVars);
    // a record that isn't public (inactive, unpublished) stays out of search
    if (!visible) resolved.noIndex = true;
    return resolved;
  }
  if (!seoListDefaults[path] && !(await SeoTemplate.exists({ resourceType: path }))) return null;
  const counter = listCounts[path];
  const vars: Vars = counter ? { count: num(fmt, await counter.model.countDocuments(counter.filter)) } : {};
  const [t, metaDoc] = await Promise.all([
    templateFor(path, locale),
    PageMeta.findOne({ resourceType: path, slug: { $exists: false } }).lean<Lean>(),
  ]);
  const o = overrideFrom(metaDoc, locale);
  const title = clampTitle(fill(t.title, vars));
  const schema: Record<string, unknown>[] =
    path === "/"
      ? [
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "@id": `${ORIGIN}/#website`,
            url: `${ORIGIN}/`,
            name: "NoyanAI",
            inLanguage: locale,
          },
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "@id": `${ORIGIN}/#organization`,
            name: "NoyanAI",
            url: `${ORIGIN}/`,
            logo: `${ORIGIN}/icons/icon-192.png`,
          },
        ]
      : [
          clean({
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "@id": `${ORIGIN}${path}#page`,
            url: `${ORIGIN}${path}`,
            name: title || undefined,
            inLanguage: locale,
          }),
          breadcrumb([
            { name: homeLabel[locale] || homeLabel.en || "", path: "/" },
            { name: plainText(title.split(" | ")[0], 60), path },
          ]),
        ];
  return assemble(t, vars, o, path, undefined, schema, withVars);
};
