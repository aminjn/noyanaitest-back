import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import { escapeRegex } from "../Lib/helpers";
import { currentLocale } from "../Lib/i18n/requestContext";
import { PUBLIC_MEDICAL } from "../Lib/medicalContent";
import { SOURCE_LOCALE } from "../Lib/locales";
import SeoTemplate from "../Models/SeoTemplate";
import {
  DirectoryKind,
  directoryFacets,
  directoryFacetTypes,
  directoryKinds,
  directoryLetters,
  directoryModels,
  displayNameExpr,
  facetPath,
  funnelSpeciality,
  isDirectoryKind,
  isFacetOf,
  resolveFacet,
} from "../Lib/medicalDirectory";

// The public medical directory (2026-10): /disease, /drug, /symptom and
// their facet pages (/disease/letter/ب, /disease/part/<slug>,
// /drug/class/<slug>, /drug/status/rx, /symptom/part/<slug>, ...). See
// Lib/medicalDirectory.ts.

const DIRECTORY_PER_PAGE = 18;

const querySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
  query: z.string().trim().max(100).optional(),
  facet: z.string().max(20).optional(),
  value: z.string().max(200).optional(),
});

// what each card needs
const cardPopulate: Record<DirectoryKind, mongoose.PopulateOptions[]> = {
  disease: [{ path: "category", match: { isActive: true }, select: "name slug translations" }],
  drug: [{ path: "tag", match: { isActive: true }, select: "name slug translations" }],
  symptom: [{ path: "part", match: { isActive: { $ne: false } }, select: "name slug translations" }],
};
const cardSelect: Record<DirectoryKind, string> = {
  disease: "name slug summary image category symptoms drugs translations",
  drug: "name slug summary image brand dosage alternateName prescriptionStatus tag translations",
  symptom: "name slug summary image part translations",
};

// GET /public/directory/:kind?page&query&facet&value
export const getDirectory: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { kind } = req.params;
    if (!isDirectoryKind(kind)) return next(new NotFoundError());
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError());
    const { page, query, facet: facetType, value } = parsed.data;
    const locale = currentLocale();

    let facet = null;
    if (facetType) {
      if (!isFacetOf(kind, facetType) || !value) return next(new NotFoundError());
      facet = await resolveFacet(kind, facetType, value, locale);
      if (!facet) return next(new NotFoundError());
    }

    // the search stays a top-level `name` condition so the translatable
    // plugin also matches the translated names
    const filter: Record<string, unknown> = {
      ...PUBLIC_MEDICAL,
      ...(query ? { name: { $regex: escapeRegex(query), $options: "i" } } : {}),
      ...(facet ? { $and: [facet.filter] } : {}),
    };

    const model = directoryModels[kind];
    const count = await model.countDocuments(filter);
    const pagesCount = Math.max(1, Math.ceil(count / DIRECTORY_PER_PAGE));
    if (page > pagesCount) return next(new NotFoundError());

    // A to Z by the name the visitor reads, in that language's order
    const ids: { _id: mongoose.Types.ObjectId }[] = await model
      .aggregate([
        { $match: filter },
        { $addFields: { _dn: displayNameExpr(locale) } },
        { $sort: { _dn: 1, _id: 1 } },
        { $skip: (page - 1) * DIRECTORY_PER_PAGE },
        { $limit: DIRECTORY_PER_PAGE },
        { $project: { _id: 1 } },
      ])
      .collation({ locale: locale === SOURCE_LOCALE ? "fa" : locale });
    const docs = await model
      .find({ _id: { $in: ids.map((d) => d._id) } })
      .select(cardSelect[kind])
      .populate(cardPopulate[kind]);
    const order = new Map(ids.map((d, i) => [String(d._id), i]));
    docs.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));

    const [letters, facets, speciality] = await Promise.all([
      directoryLetters(kind, locale),
      directoryFacets(kind),
      facet || query ? funnelSpeciality(kind, filter, facet) : Promise.resolve(null),
    ]);

    res.status(200).json({
      message: "getDirectory",
      data: {
        kind,
        data: docs,
        count,
        page,
        pagesCount,
        letters,
        facets,
        active: facet ? { type: facet.type, value: facet.value, node: facet.node } : null,
        funnel: { speciality },
      },
    });
  },
);

// GET /public/directory/sitemap - every facet page that lists something,
// for /sitemap/directory.xml; a facet type the super admin set to noindex
// in «سئوی خودکار» is left out
export const getDirectorySitemap: RequestHandler = catchAsync(
  async (_req: Request, res: Response) => {
    const noIndex = new Set(
      (await SeoTemplate.find({ noIndex: true }).select("resourceType").lean()).map(
        (t) => t.resourceType,
      ),
    );
    const paths: string[] = [];
    for (const kind of directoryKinds) {
      const allowed = (type: string) =>
        !noIndex.has(`/${kind}/${type}/[${type === "letter" ? "letter" : "slug"}]`);
      const [letters, facets] = await Promise.all([
        directoryLetters(kind, SOURCE_LOCALE),
        directoryFacets(kind),
      ]);
      if (allowed("letter"))
        for (const { letter, count } of letters)
          if (count > 0) paths.push(facetPath(kind, "letter", letter));
      const lists: [string, { slug?: string; count: number }[] | undefined][] = [
        ["part", facets.parts],
        ["speciality", facets.specialities],
        ["category", facets.categories],
        ["class", facets.classes],
      ];
      for (const [type, rows] of lists) {
        if (!rows || !isAllowedType(kind, type) || !allowed(type)) continue;
        for (const row of rows) if (row.slug && row.count > 0) paths.push(`/${kind}/${type}/${row.slug}`);
      }
      if (kind === "drug" && !noIndex.has("/drug/status/[slug]"))
        for (const s of facets.statuses || []) if (s.count > 0) paths.push(`/drug/status/${s.value}`);
    }
    res.status(200).json({ message: "getDirectorySitemap", data: { paths } });
  },
);

const isAllowedType = (kind: DirectoryKind, type: string) =>
  (directoryFacetTypes[kind] as readonly string[]).includes(type);
