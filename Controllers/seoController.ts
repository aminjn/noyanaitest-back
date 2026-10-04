import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import SeoTemplate from "../Models/SeoTemplate";
import { isLocale, Locale, locales } from "../Lib/locales";
import {
  clearSeoCache,
  defaultTemplate,
  facetSample,
  isSeoPageType,
  resolveSeo,
  seoNodeTypes,
  seoVariables,
} from "../Lib/seo/seoResolver";
import { seoListDefaults } from "../Lib/seo/seoDefaults";

// GET /public/seo?path=/dr/[slug]&slug=... - the finished SEO of one page
// (title, description, keywords, canonical, image, robots, structured
// data), built from its template and record (Lib/seo/seoResolver.ts).
export const getPageSeo: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
    if (!path || !isSeoPageType(path)) return next(new BadInputError());
    const data = await resolveSeo(path, slug);
    res.status(200).json({ message: "getPageSeo", data });
  },
);

// ---------------------------------------------------------------- admin

const allTypes = () => [...seoNodeTypes, ...Object.keys(seoListDefaults)];

// GET /admin/seo/templates - every page type: the saved template (all
// languages, as stored) and the built-in default in the site's languages
export const listSeoTemplates: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const saved = await SeoTemplate.find({}).lean();
  const byType = new Map(saved.map((s) => [s.resourceType, s]));
  const data = allTypes().map((path) => ({
    path,
    kind: seoNodeTypes.includes(path) ? "node" : "list",
    variables: seoVariables[path] || [],
    saved: byType.get(path) || null,
    defaults: Object.fromEntries(
      (["fa", "en", "ar"] as Locale[]).map((l) => [l, defaultTemplate(path, l)]),
    ),
  }));
  res.status(200).json({ message: "listSeoTemplates", data });
});

const templateSchema = z.strictObject({
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional(),
  keywords: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  noIndex: z.boolean().optional(),
  // per-language versions: { en: { title, description, keywords }, ... }
  translations: z
    .record(
      z.string(),
      z.strictObject({
        title: z.string().trim().max(300).optional(),
        description: z.string().trim().max(1000).optional(),
        keywords: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
      }),
    )
    .optional(),
});

const pathParam = (req: Request) => {
  const path = typeof req.query.path === "string" ? req.query.path : "";
  return isSeoPageType(path) ? path : null;
};

// PUT /admin/seo/template?path=... - save one page type's template
export const saveSeoTemplate: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const path = pathParam(req);
    if (!path) return next(new BadInputError());
    const parsed = templateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { translations, ...rest } = parsed.data;
    const cleanTranslations = translations
      ? Object.fromEntries(Object.entries(translations).filter(([l]) => isLocale(l) && (locales as readonly string[]).includes(l)))
      : undefined;
    await SeoTemplate.updateOne(
      { resourceType: path },
      { $set: { ...rest, ...(cleanTranslations ? { translations: cleanTranslations } : {}) } },
      { upsert: true },
    );
    clearSeoCache();
    res.status(200).json({ message: "saveSeoTemplate" });
  },
);

// DELETE /admin/seo/template?path=... - back to the built-in template
export const resetSeoTemplate: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const path = pathParam(req);
    if (!path) return next(new BadInputError());
    await SeoTemplate.deleteOne({ resourceType: path });
    clearSeoCache();
    res.status(200).json({ message: "resetSeoTemplate" });
  },
);

// GET /admin/seo/preview?path=...&slug=...&locale=... - what a page gets
// right now, with the variables that filled it; without a slug, the first
// public record of that type
export const previewSeo: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const path = pathParam(req);
    if (!path) return next(new BadInputError());
    const locale = isLocale(req.query.locale) ? req.query.locale : undefined;
    let slug = typeof req.query.slug === "string" && req.query.slug ? req.query.slug : undefined;
    if (!slug && seoNodeTypes.includes(path))
      slug = (await sampleSlug(path)) || (await facetSample(path)) || undefined;
    clearSeoCache();
    const data = await resolveSeo(path, slug, { withVars: true, locale });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "previewSeo", data: { ...data, slug } });
  },
);

import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";
import Insurance from "../Models/Insurance";
import Drug from "../Models/Drug";
import Disease from "../Models/Disease";
import Symptom from "../Models/Symptom";
import Speciality from "../Models/Speciality";
import Service from "../Models/Service";
import ServicePackage from "../Models/ServicePackage";
import Product from "../Models/Product";
import ProductPackage from "../Models/ProductPackage";
import Blog from "../Models/Blog";
import mongoose from "mongoose";

const sampleModels: Record<string, mongoose.Model<any>> = {
  "/dr/[slug]": DoctorProfile,
  "/clinic/[slug]": Clinic,
  "/hospital/[slug]": Hospital,
  "/paraClinic/[slug]": ParaClinic,
  "/pharmacy/[slug]": Pharmacy,
  "/insurance/[slug]": Insurance,
  "/drug/[slug]": Drug,
  "/disease/[slug]": Disease,
  "/symptom/[slug]": Symptom,
  "/speciality/[slug]": Speciality,
  "/service/[slug]": Service,
  "/servicePackage/[slug]": ServicePackage,
  "/product/[slug]": Product,
  "/productPackage/[slug]": ProductPackage,
  "/mag/[blogSlug]": Blog,
};

const sampleSlug = async (path: string) => {
  const model = sampleModels[path];
  if (!model) return null;
  const doc = await model
    .findOne({ slug: { $exists: true, $nin: [null, ""] } })
    .sort({ _id: -1 })
    .select("slug")
    .lean<{ slug?: string }>();
  return doc?.slug || null;
};
