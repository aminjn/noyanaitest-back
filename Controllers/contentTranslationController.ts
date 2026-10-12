import { NextFunction, Request, RequestHandler, Response } from "express";
import { Model } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { isLocale, Locale, SOURCE_LOCALE } from "../Lib/locales";
import { TranslatableFields } from "../Lib/i18n/translatable";
import { translatableFields } from "../Lib/i18n/translatableFields";
import {
  LocaleBag,
  machineTranslationEnabled,
  pendingFields,
  sourceHash,
  targetLocales,
  translateDocument,
} from "../Services/machineTranslation";
import {
  lastScan,
  pauseTranslationWorker,
  runTranslationBackfill,
  translationQueueStatus,
  translationTargets,
} from "../Services/autoTranslate";

// Admin side of DB-content translation: list records of a translatable
// auto segment with their per-language status, edit one record's
// translations by hand, or machine-translate it (or everything, as a
// background job).

export type TranslationSegment = { name: string; model: Model<any> };

export const fieldsOf = (model: Model<any>): TranslatableFields | undefined =>
  translatableFields[model.modelName];

const NotConfiguredError = () =>
  new AppError("ترجمه خودکار تنظیم نشده است", 400);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const labelField = (fields: TranslatableFields) =>
  Object.keys(fields).find((f) => fields[f] === "line") || Object.keys(fields)[0];

const hasText = (value: unknown) =>
  Array.isArray(value)
    ? value.some((v) => typeof v === "string" && v.trim())
    : typeof value === "string" && value.trim() !== "";

// Per-language state of one record: "done" (every field with Persian text
// is translated and current), "partial", or absent (nothing yet).
const statusOf = (doc: Record<string, any>, fields: TranslatableFields, locales: readonly Locale[]) => {
  const status: Partial<Record<Locale, "done" | "partial">> = {};
  for (const locale of locales) {
    const bag = doc.translations?.[locale] as LocaleBag | undefined;
    if (!bag || !Object.keys(fields).some((f) => hasText(bag[f]))) continue;
    status[locale] = pendingFields(doc, fields, locale, false).length
      ? "partial"
      : "done";
  }
  return status;
};

// GET /auto/_translations
export const getOverview = (segments: TranslationSegment[]): RequestHandler =>
  catchAsync(async (req: Request, res: Response) => {
    const data = await Promise.all(
      segments.map(async ({ name, model }) => ({
        segment: name,
        model: model.modelName,
        fields: fieldsOf(model),
        total: await model.estimatedDocumentCount(),
      })),
    );
    // the enabled site languages (the ones the queue translates into)
    const status = await translationQueueStatus();
    res.status(200).json({
      message: "getOverview",
      data: {
        machine: status.ready,
        locales: status.locales,
        segments: data,
        queue: status.queue,
        scan: status.scan,
      },
    });
  });

// GET /auto/<segment>/_translations?q=&page=&limit=
export const listRecords = ({ model }: TranslationSegment): RequestHandler =>
  catchAsync(async (req: Request, res: Response) => {
    const fields = fieldsOf(model)!;
    const label = labelField(fields);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const filter = q ? { [label]: { $regex: escapeRegex(q), $options: "i" } } : {};
    const projection = Object.fromEntries(
      [...Object.keys(fields), "translations"].map((f) => [f, 1]),
    );
    const locales = await translationTargets();
    const [docs, total] = await Promise.all([
      model
        .find(filter, projection)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      model.countDocuments(filter),
    ]);
    res.status(200).json({
      message: "listRecords",
      data: {
        total,
        page,
        limit,
        items: docs.map((doc: any) => ({
          _id: doc._id,
          label: Array.isArray(doc[label]) ? doc[label].join("، ") : doc[label] || "",
          status: statusOf(doc, fields, locales),
        })),
      },
    });
  });

// GET /auto/<segment>/:nodeId/_translations
export const getRecord = ({ model }: TranslationSegment): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const fields = fieldsOf(model)!;
    const doc: any = await model
      .findById(req.params.nodeId, [...Object.keys(fields), "translations"])
      .lean();
    if (!doc) return next(new NotFoundError());
    const stale: Partial<Record<Locale, string[]>> = {};
    for (const locale of targetLocales) {
      const bag = doc.translations?.[locale] as LocaleBag | undefined;
      const outdated = Object.keys(fields).filter(
        (f) => bag?._src?.[f] && bag._src[f] !== sourceHash(doc[f]) && hasText(bag[f]),
      );
      if (outdated.length) stale[locale] = outdated;
    }
    res.status(200).json({
      message: "getRecord",
      data: {
        fields,
        source: Object.fromEntries(Object.keys(fields).map((f) => [f, doc[f]])),
        translations: doc.translations || {},
        stale,
        machine: await machineTranslationEnabled(),
      },
    });
  });

// POST /auto/<segment>/:nodeId/_translations  { locale, values: {field: value} }
// A hand-edited value drops its machine fingerprint, so it is never
// replaced automatically; an empty value removes the translation.
export const saveRecord = ({ model }: TranslationSegment): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const fields = fieldsOf(model)!;
    const { locale, values } = req.body || {};
    if (!isLocale(locale) || locale === SOURCE_LOCALE || !values || typeof values !== "object")
      return next(new BadInputError());
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    for (const [field, raw] of Object.entries(values as Record<string, unknown>)) {
      const kind = fields[field];
      if (!kind) continue;
      const value =
        kind === "list"
          ? Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === "string" && !!v.trim())
            : []
          : typeof raw === "string"
            ? raw
            : "";
      const path = `translations.${locale}.${field}`;
      if (hasText(value)) $set[path] = value;
      else $unset[path] = 1;
      $unset[`translations.${locale}._src.${field}`] = 1;
    }
    const result = await model.updateOne(
      { _id: req.params.nodeId },
      { ...(Object.keys($set).length && { $set }), $unset },
      { strict: false },
    );
    if (!result.matchedCount) return next(new NotFoundError());
    res.status(200).json({ message: "saveRecord" });
  });

// POST /auto/<segment>/:nodeId/_translations/auto  { locales?, overwrite? }
export const autoTranslateRecord = ({ model }: TranslationSegment): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!(await machineTranslationEnabled())) return next(NotConfiguredError());
    const fields = fieldsOf(model)!;
    const requested: unknown[] = Array.isArray(req.body?.locales) ? req.body.locales : [];
    const targets = requested.length
      ? targetLocales.filter((l) => requested.includes(l))
      : targetLocales;
    const doc = await model
      .findById(req.params.nodeId, [...Object.keys(fields), "translations"])
      .lean();
    if (!doc) return next(new NotFoundError());
    const written = await translateDocument(
      model,
      doc as Record<string, any>,
      fields,
      targets,
      !!req.body?.overwrite,
    );
    res.status(200).json({ message: "autoTranslateRecord", data: { written } });
  });

// ---- Automatic translation: queue, backfill, status ----------------------
// (Services/autoTranslate.ts). The old in-memory bulk job is replaced by the
// stored queue: the same routes start a backfill, report it, and pause it.

// GET /auto/_translations/bulk
export const bulkStatus: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ message: "bulkStatus", data: await translationQueueStatus() });
});

// POST /auto/_translations/bulk - scan everything, queue what is missing
// (failed records are retried) and resume the worker. Works without an AI
// provider too: the queue fills and waits for one.
export const startBulk = (): RequestHandler =>
  catchAsync(async (_req: Request, res: Response, next: NextFunction) => {
    if (lastScan().running) return next(new AppError("بررسی ترجمه‌های ناقص همین حالا در حال اجراست", 409));
    pauseTranslationWorker(false);
    void runTranslationBackfill({ reason: "admin", retryFailed: true }).catch(() => undefined);
    res.status(202).json({ message: "startBulk", data: await translationQueueStatus() });
  });

// DELETE /auto/_translations/bulk - pause the worker (until resumed or the
// next restart); the queue is kept
export const stopBulk: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  pauseTranslationWorker(true);
  res.status(200).json({ message: "stopBulk", data: await translationQueueStatus() });
});
