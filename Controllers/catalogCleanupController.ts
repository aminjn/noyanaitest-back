import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError } from "../Lib/AppError";
import { catalogKinds, CatalogKind } from "../Lib/catalog/catalogMatch";
import {
  archiveUnused,
  catalogRows,
  CatalogMergeError,
  duplicateGroups,
  mergeEntries,
  resolveSuggestion,
  seedCanonicalSpecialities,
  undoMerge,
} from "../Services/catalogCleanup";
import CatalogSuggestion from "../Models/CatalogSuggestion";
import CatalogMerge from "../Models/CatalogMerge";

// The super admin's «ادغام و پاک‌سازی» tab (2026-10): duplicate groups,
// one-click merges (and their undo), the unused entries, the canonical
// speciality list and the names imports could not place.

const kindOf = (req: Request): CatalogKind | null =>
  (catalogKinds as string[]).includes(req.params.kind) ? (req.params.kind as CatalogKind) : null;

const asAppError = (err: unknown) => (err instanceof CatalogMergeError ? new AppError(err.message, 400) : err);

const actor = (req: Request) => (req as unknown as { user?: { _id?: unknown } }).user?._id;

// GET /admin/catalog/:kind/overview - the numbers on the tab's header
export const getOverview: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const rows = await catalogRows(kind);
  const live = rows.filter((r) => !r.archived);
  res.status(200).json({
    message: "getCatalogOverview",
    data: {
      total: live.length,
      canonical: live.filter((r) => r.canonical).length,
      unused: live.filter((r) => !r.canonical && !r.doctors).length,
      archived: rows.length - live.length,
      pending: await CatalogSuggestion.countDocuments({ kind, status: "pending" }),
    },
  });
});

// GET /admin/catalog/:kind/duplicates
export const getDuplicates: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const groups = await duplicateGroups(kind);
  res.status(200).json({
    message: "getCatalogDuplicates",
    data: groups.slice(0, 300).map((g) => ({
      _id: g.target.id,
      target: g.target,
      members: g.members,
    })),
  });
});

const mergeSchema = z.object({
  target: z.string().min(1),
  sources: z.array(z.string()).min(1).max(500),
});

// POST /admin/catalog/:kind/merge { target, sources }
export const merge: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  const body = mergeSchema.safeParse(req.body);
  if (!kind || !body.success) return next(new BadInputError());
  try {
    res.status(200).json({ message: "mergeCatalog", data: await mergeEntries(kind, body.data.target, body.data.sources, actor(req)) });
  } catch (err) {
    next(asAppError(err));
  }
});

// POST /admin/catalog/:kind/merge-all - every suggested group into its target
export const mergeAll: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const groups = await duplicateGroups(kind);
  let merged = 0;
  for (const g of groups) {
    try {
      merged += (await mergeEntries(kind, g.target.id, g.members.map((m) => m.row.id), actor(req))).merged;
    } catch {
      // a group another merge of this run already emptied
    }
  }
  res.status(200).json({ message: "mergeAllCatalog", data: { groups: groups.length, merged } });
});

// GET /admin/catalog/:kind/merges - the latest merges (to undo one)
export const getMerges: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const rows = await CatalogMerge.find({ kind }).sort({ createdAt: -1 }).limit(100).select("-moved").lean();
  const ids = rows.flatMap((r) => [r.target, ...(r.sources || [])]).map(String);
  const names = new Map((await catalogRows(kind)).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.name]));
  res.status(200).json({
    message: "getCatalogMerges",
    data: rows.map((r) => ({
      ...r,
      targetName: names.get(String(r.target)) || "",
      sourceNames: (r.sources || []).map((s) => names.get(String(s)) || ""),
    })),
  });
});

// POST /admin/catalog/merges/:nodeId/undo
export const undo: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ message: "undoCatalogMerge", data: await undoMerge(req.params.nodeId) });
  } catch (err) {
    next(asAppError(err));
  }
});

// POST /admin/catalog/:kind/archive-unused { dry? }
export const archiveUnusedEntries: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  res.status(200).json({ message: "archiveUnused", data: await archiveUnused(kind, !!req.body?.dry) });
});

// POST /admin/catalog/speciality/seed - the canonical list of Iran
export const seedSpecialities: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ message: "seedSpecialities", data: await seedCanonicalSpecialities() });
});

// GET /admin/catalog/:kind/suggestions
export const getSuggestions: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const data = await CatalogSuggestion.find({ kind, status: "pending" })
    .sort({ doctorCount: -1, updatedAt: -1 })
    .limit(500)
    .select("-doctors -drafts")
    .lean();
  res.status(200).json({ message: "getCatalogSuggestions", data });
});

const resolveSchema = z.object({
  action: z.enum(["map", "create", "reject"]),
  target: z.string().optional(),
});

// POST /admin/catalog/suggestions/:nodeId { action, target? }
export const resolve: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const body = resolveSchema.safeParse(req.body);
  if (!body.success) return next(new BadInputError());
  try {
    res.status(200).json({
      message: "resolveCatalogSuggestion",
      data: await resolveSuggestion(req.params.nodeId, body.data.action, body.data.target, actor(req)),
    });
  } catch (err) {
    next(asAppError(err));
  }
});

// GET /admin/catalog/:kind/entries - the live entries a name can be mapped to
export const getEntries: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = kindOf(req);
  if (!kind) return next(new BadInputError());
  const rows = (await catalogRows(kind))
    .filter((r) => !r.archived)
    .sort((a, b) => Number(!!b.canonical) - Number(!!a.canonical) || (b.doctors || 0) - (a.doctors || 0) || a.name.localeCompare(b.name, "fa"))
    .slice(0, 2000)
    .map((r) => ({ id: r.id, name: r.name, canonical: !!r.canonical, doctors: r.doctors || 0 }));
  res.status(200).json({ message: "getCatalogEntries", data: rows });
});
