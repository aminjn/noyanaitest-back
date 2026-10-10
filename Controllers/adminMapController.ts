import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AppConfig from "../Models/AppConfig";
import { getAppConfig } from "../Lib/appConfig";
import {
  clearNexaMapSettingsCache,
  getNexaMapSettings,
  nexamap,
  NexaMapError,
  nexamapUsage,
  normalizeNexaMapBase,
} from "../Lib/nexamap";
import { currentLocale } from "../Lib/i18n/requestContext";
import { translateMessage } from "../Lib/i18n/translateMessage";
import { isMaskedSecret, maskSecret } from "../Lib/secretMask";
import { getMapJob, MapJobKind, startBatchGeocode, startDivisionsSync } from "../Lib/nexamapAdmin";
import { countPlaces, PlaceKind, placeKinds, streamPlaces } from "../Lib/mapPlacesExport";
import { parseTehranDay } from "../Lib/tehranTime";

// Super admin: NexaMap settings, a status card, and the two map jobs
// (divisions import, batch geocode). Routers/adminRouter.ts mounts these at
// /admin/map/* for the "admin" role only. The API key is write-only here:
// reads get a masked preview, and a save changes it only when a new value is
// typed.

const errorOut = (err: unknown) => {
  const code = err instanceof NexaMapError ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return { code, message: translateMessage(message, currentLocale()) };
};

// GET /admin/map/settings
export const getMapSettings: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const config = await getAppConfig();
  const stored = config.nexamapApiKey || "";
  const envKey = process.env.NEXAMAP_API_KEY || "";
  res.status(200).json({
    message: "getMapSettings",
    data: {
      nexamapEnabled: !!config.nexamapEnabled,
      nexamapBaseUrl: config.nexamapBaseUrl || "",
      nexamapDefaultStyle: config.nexamapDefaultStyle || "day",
      nexamapDarkStyle: config.nexamapDarkStyle || "night",
      nexamapNavUrl: config.nexamapNavUrl || "",
      apiKeySet: !!stored,
      apiKeyPreview: maskSecret(stored),
      // no key saved here, but the server's .env has one
      apiKeyFromEnv: !stored && !!envKey,
      envBaseUrl: !!process.env.NEXAMAP_BASE_URL,
    },
  });
});

const settingsSchema = z.strictObject({
  nexamapEnabled: z.boolean().optional(),
  nexamapBaseUrl: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v))
    .optional(),
  // empty / masked: keep the stored key
  nexamapApiKey: z.string().trim().max(400).optional(),
  clearApiKey: z.boolean().optional(),
  nexamapDefaultStyle: z.string().trim().max(60).regex(/^[\w.-]*$/).optional(),
  nexamapDarkStyle: z.string().trim().max(60).regex(/^[\w.-]*$/).optional(),
  // https only, and it must carry the destination
  nexamapNavUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || (/^https:\/\/[^\s]+$/i.test(v) && v.includes("{lat}") && v.includes("{lng}")))
    .optional(),
});

// POST /admin/map/settings
export const saveMapSettings: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, success } = settingsSchema.safeParse(req.body || {});
  if (!success) return next(new BadInputError());
  const $set: Record<string, unknown> = {};
  if (data.nexamapEnabled !== undefined) $set.nexamapEnabled = data.nexamapEnabled;
  if (data.nexamapBaseUrl !== undefined)
    $set.nexamapBaseUrl = normalizeNexaMapBase(data.nexamapBaseUrl);
  if (data.nexamapDefaultStyle) $set.nexamapDefaultStyle = data.nexamapDefaultStyle;
  if (data.nexamapDarkStyle) $set.nexamapDarkStyle = data.nexamapDarkStyle;
  if (data.nexamapNavUrl !== undefined) $set.nexamapNavUrl = data.nexamapNavUrl;
  if (data.clearApiKey) $set.nexamapApiKey = "";
  else if (data.nexamapApiKey && !isMaskedSecret(data.nexamapApiKey)) $set.nexamapApiKey = data.nexamapApiKey;
  await getAppConfig();
  if (Object.keys($set).length) await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set });
  clearNexaMapSettingsCache();
  res.status(200).json({ message: "saveMapSettings" });
});

// POST /admin/map/test - one reverse geocode of central Tehran with the
// saved settings, uncached
export const testMapConnection: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  clearNexaMapSettingsCache();
  const settings = await getNexaMapSettings();
  const started = Date.now();
  try {
    const { data, meta, requestId } = await nexamap<{ results?: { formatted_address?: string }[] }>("GET", "/v1/reverse", {
      query: { lat: 35.6997, lng: 51.338, lang: "fa" },
    });
    res.status(200).json({
      message: "testMapConnection",
      data: {
        ok: true,
        latencyMs: Date.now() - started,
        baseUrl: settings.baseUrl,
        address: data?.results?.[0]?.formatted_address || null,
        dataVersion: meta?.data_version || nexamapUsage.dataVersion || null,
        requestId: requestId || null,
      },
    });
  } catch (err) {
    res.status(200).json({
      message: "testMapConnection",
      data: { ok: false, latencyMs: Date.now() - started, baseUrl: settings.baseUrl, error: errorOut(err) },
    });
  }
});

// GET /admin/map/status - this server's counters and the account's usage
export const getMapStatus: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const settings = await getNexaMapSettings();
  let account: unknown = null;
  let accountError: { code: string; message: string } | null = null;
  if (settings.enabled) {
    try {
      account = (await nexamap("GET", "/v1/usage", { ttlMs: 60_000 })).data;
    } catch (err) {
      accountError = errorOut(err);
    }
  }
  res.status(200).json({
    message: "getMapStatus",
    data: {
      enabled: settings.enabled,
      server: { ...nexamapUsage },
      account,
      accountError,
    },
  });
});

const jobKinds: MapJobKind[] = ["divisions", "geocode"];

// GET /admin/map/jobs/:kind - the latest job of that kind (null: none yet)
export const getMapJobStatus: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = req.params.kind as MapJobKind;
  if (!jobKinds.includes(kind)) return next(new BadInputError());
  const job = getMapJob(kind);
  res.status(200).json({
    message: "getMapJob",
    data: job
      ? { ...job, error: job.error ? { ...job.error, message: translateMessage(job.error.message, currentLocale()) } : undefined }
      : null,
  });
});

const ensureEnabled = async () => {
  const settings = await getNexaMapSettings();
  if (!settings.enabled) throw new NexaMapError("NOT_CONFIGURED");
};

// POST /admin/map/divisions/sync { replaceGeometry? }
export const syncDivisions: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, success } = z.object({ replaceGeometry: z.boolean().optional() }).safeParse(req.body || {});
  if (!success) return next(new BadInputError());
  await ensureEnabled();
  const job = startDivisionsSync({ replaceGeometry: !!data.replaceGeometry });
  res.status(202).json({ message: "syncDivisions", data: job });
});

// POST /admin/map/geocode/batch { dryRun? }
export const batchGeocodeProviders: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, success } = z.object({ dryRun: z.boolean().optional() }).safeParse(req.body || {});
  if (!success) return next(new BadInputError());
  await ensureEnabled();
  const job = startBatchGeocode({ dryRun: !!data.dryRun });
  res.status(202).json({ message: "batchGeocode", data: job });
});

// ---- places export for NexaMap (2026-10, Lib/mapPlacesExport.ts) ----

const placesQuerySchema = z.object({
  // comma-separated kinds; none = every kind
  types: z.string().max(200).optional(),
  // a Tehran day (YYYY-MM-DD) or an ISO date: only places changed since
  since: z.string().max(40).optional(),
  format: z.enum(["jsonl", "geojson"]).optional(),
});

const parsePlacesQuery = (query: unknown) => {
  const { data, success } = placesQuerySchema.safeParse(query || {});
  if (!success) return null;
  const asked = (data.types || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (asked.some((k) => !(placeKinds as readonly string[]).includes(k))) return null;
  const kinds = (asked.length ? placeKinds.filter((k) => asked.includes(k)) : [...placeKinds]) as PlaceKind[];
  let since: Date | null = null;
  if (data.since) {
    since = parseTehranDay(data.since);
    if (!since) return null;
  }
  return { kinds, since, format: data.format || "jsonl" };
};

// GET /admin/map/places/count?types=&since= - the preview of the export
export const countMapPlaces: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = parsePlacesQuery(req.query);
  if (!parsed) return next(new BadInputError());
  const counts = await countPlaces(parsed);
  const config = await getAppConfig();
  res.status(200).json({
    message: "countMapPlaces",
    data: {
      counts,
      total: Object.values(counts).reduce((a, b) => a + (b || 0), 0),
      // the lines' page links are absolute only with the site address set
      siteBaseUrl: config.siteBaseUrl || "",
    },
  });
});

// GET /admin/map/places.jsonl?types=&since=&format= - one JSON line per
// public provider place (application/x-ndjson), streamed from a cursor
export const exportMapPlaces: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = parsePlacesQuery(req.query);
  if (!parsed) return next(new BadInputError());
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="noyanai-places-${stamp}.${parsed.format === "geojson" ? "geojsonl" : "jsonl"}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const write = (line: string) =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      if (res.write(line)) return resolve();
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
  try {
    await streamPlaces(parsed, write, () => closed);
  } catch (err) {
    // headers are gone: end the file; the admin sees a short download
    console.log("[map] places export failed:", err);
  }
  if (!closed) res.end();
});
