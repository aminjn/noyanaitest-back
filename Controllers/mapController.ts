import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { getAppConfig } from "../Lib/appConfig";
import { BadInputError } from "../Lib/AppError";
import {
  getNexaMapSettings,
  isLatLng,
  LatLng,
  nexamap,
  nexamapRaw,
  NexaMapError,
  reverseGeocode,
} from "../Lib/nexamap";

// The site's window onto NexaMap (Lib/nexamap.ts). The browser never sees
// the API key: maps load their style and tiles through /map/style.json and
// /map/raw, and every lookup (search, address, route, ...) is a call here.
// Answers keep NexaMap's `meta.attribution`, which every map must show.

const ATTRIBUTION = "© NexaMap، © OpenStreetMap contributors";

const send = (res: Response, data: unknown, meta?: { attribution?: string }) =>
  res.status(200).json({
    message: "ok",
    data,
    meta: { attribution: meta?.attribution || ATTRIBUTION },
  });

const num = z.coerce.number().refine(Number.isFinite);
const lat = num.refine((v) => Math.abs(v) <= 90);
const lng = num.refine((v) => Math.abs(v) <= 180);
const point = z.object({ lat, lng });
const modes = ["car", "motorcycle", "truck", "bike", "pedestrian"] as const;

const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const out = schema.safeParse(value);
  if (!out.success) throw new BadInputError();
  return out.data;
};

// a simple per-IP budget so a public endpoint can't drain the key's credits
const buckets = new Map<string, { at: number; n: number }>();
export const mapRateLimit =
  (perMinute: number): RequestHandler =>
  (req, _res, next) => {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "?";
    const key = `${perMinute}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.at > 60_000) {
      buckets.set(key, { at: now, n: 1 });
      if (buckets.size > 50_000) buckets.clear();
      return next();
    }
    bucket.n += 1;
    if (bucket.n > perMinute) return next(new NexaMapError("RATE_LIMITED"));
    next();
  };

// public absolute origin of this API, as the browser reaches it
const publicApiBase = (req: Request) => {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0] || req.get("host");
  return `${proto}://${host}/api/v1/map/raw`;
};

// --- map display ---

export const getMapConfig: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const settings = await getNexaMapSettings();
  send(res, {
    enabled: settings.enabled,
    provider: "nexamap",
    // "Open in navigation" on NexaMap itself ({lat} {lng} {name}); null = our route page
    navUrl: (await getAppConfig()).nexamapNavUrl || null,
    styles: settings.enabled
      ? {
          light: `${publicApiBase(req).replace(/\/raw$/, "")}/style.json?theme=light`,
          dark: `${publicApiBase(req).replace(/\/raw$/, "")}/style.json?theme=dark`,
        }
      : null,
    features: {
      search: settings.enabled,
      reverse: settings.enabled,
      route: settings.enabled,
      isochrone: settings.enabled,
      traffic: settings.enabled,
      parking: settings.enabled,
      airQuality: settings.enabled,
      staticMap: settings.enabled,
    },
  });
});

// NexaMap's MapLibre style, with every URL of the provider rewritten to
// our raw proxy (the key is added there, server side).
export const getStyle: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const settings = await getNexaMapSettings();
  const theme = req.query.theme === "dark" ? "dark" : "light";
  // a MapLibre style is plain JSON, maybe wrapped in the envelope
  const raw = await nexamapRaw("/v1/style.json", {
    query: { style: theme === "dark" ? settings.nightStyle : settings.dayStyle },
    ttlMs: 3600_000,
  });
  const parsed = JSON.parse(raw.body.toString("utf8"));
  const style = (parsed?.status === "OK" && parsed.data ? parsed.data : parsed) as Record<string, unknown>;
  const proxy = publicApiBase(req);
  const provider = settings.baseUrl;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      if (out.startsWith(provider)) out = proxy + out.slice(provider.length).replace(/^\/v1/, "/v1");
      else if (out.startsWith("/v1/")) out = proxy + out;
      // never forward a key a style may carry
      return out.replace(/([?&])key=[^&]*&?/, "$1").replace(/[?&]$/, "");
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    return value;
  };
  res.set("Cache-Control", "public, max-age=3600");
  res.status(200).json(rewrite(style));
});

// Tiles, glyphs and sprites the style points at. Only those paths pass:
// this is not a general door to the provider.
const RAW_ALLOWED = /^\/v1\/(tiles|fonts|glyphs|sprite|sprites|styles|style)(\/|\.|$)/;
export const getRaw: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const path = `/${(req.params as Record<string, string>)[0] || ""}`;
  if (!RAW_ALLOWED.test(path) || path.includes("..")) return next(new BadInputError());
  const query = Object.fromEntries(
    Object.entries(req.query).filter(([k, v]) => k !== "key" && typeof v === "string"),
  ) as Record<string, string>;
  const out = await nexamapRaw(path, { query, ttlMs: path.startsWith("/v1/tiles") ? 3600_000 : 24 * 3600_000 });
  if (out.status === 204) return res.status(204).end();
  res.set("Content-Type", out.contentType);
  res.set("Cache-Control", "public, max-age=86400");
  if (out.dataVersion) res.set("X-Data-Version", out.dataVersion);
  res.status(200).send(out.body);
});

// A static map image (doctor/clinic cards, emails): no JS, cached a day.
const staticSchema = z.object({
  center: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  zoom: num.refine((v) => v >= 0 && v <= 20).optional(),
  width: num.refine((v) => v >= 32 && v <= 1280).optional(),
  height: num.refine((v) => v >= 32 && v <= 1280).optional(),
  scale: num.refine((v) => v >= 1 && v <= 3).optional(),
  style: z.string().max(20).optional(),
  format: z.enum(["png", "jpg", "jpeg", "webp"]).optional(),
  marker: z.union([z.string(), z.array(z.string())]).optional(),
  path: z.union([z.string(), z.array(z.string())]).optional(),
  polygon: z.union([z.string(), z.array(z.string())]).optional(),
  circle: z.union([z.string(), z.array(z.string())]).optional(),
});
export const getStaticMap: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(staticSchema, req.query);
  const list = (v?: string | string[]) => (v === undefined ? undefined : Array.isArray(v) ? v.slice(0, 20) : [v]);
  const out = await nexamapRaw("/v1/staticmap", {
    query: {
      center: q.center,
      zoom: q.zoom,
      width: q.width ?? 600,
      height: q.height ?? 400,
      scale: q.scale,
      style: q.style,
      format: q.format ?? "webp",
      marker: list(q.marker),
      path: list(q.path),
      polygon: list(q.polygon),
      circle: list(q.circle),
    },
    ttlMs: 24 * 3600_000,
  });
  res.set("Content-Type", out.contentType);
  res.set("Cache-Control", "public, max-age=86400");
  res.status(200).send(out.body);
});

// --- search and addresses ---

export const geocode: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ address: z.string().trim().min(2).max(300), lang: z.enum(["fa", "en"]).optional() }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/geocode", { query: q, ttlMs: 24 * 3600_000 });
  send(res, data, meta);
});

export const reverse: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ lat, lng, lang: z.enum(["fa", "en"]).optional() }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/reverse", { query: q, ttlMs: 24 * 3600_000 });
  send(res, data, meta);
});

export const autocomplete: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(
    z.object({
      q: z.string().trim().min(1).max(120),
      lat: lat.optional(),
      lng: lng.optional(),
      session_token: z.string().max(80).optional(),
      limit: num.refine((v) => v >= 1 && v <= 20).optional(),
    }),
    req.query,
  );
  const { data, meta } = await nexamap("GET", "/v1/autocomplete", { query: q, ttlMs: 10 * 60_000 });
  send(res, data, meta);
});

export const search: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(
    z.object({
      q: z.string().trim().max(120).optional(),
      lat: lat.optional(),
      lng: lng.optional(),
      radius: num.refine((v) => v > 0 && v <= 50_000).optional(),
      limit: num.refine((v) => v >= 1 && v <= 50).optional(),
    }),
    req.query,
  );
  const { data, meta } = await nexamap("GET", "/v1/search", { query: q, ttlMs: 10 * 60_000 });
  send(res, data, meta);
});

export const placeDetails: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ place_key: z.string().min(1).max(200) }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/places/details", { query: q, ttlMs: 3600_000 });
  send(res, data, meta);
});

// --- divisions (province / city / district) ---

export const divisions: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const kind = req.params.kind;
  const schemas: Record<string, z.ZodTypeAny> = {
    resolve: z.object({ lat, lng }),
    provinces: z.object({ geometry: z.enum(["true", "false"]).optional() }),
    cities: z.object({ province: z.string().max(40).optional(), geometry: z.enum(["true", "false"]).optional() }),
    districts: z.object({ city: z.string().max(40), geometry: z.enum(["true", "false"]).optional() }),
    search: z.object({ query: z.string().trim().min(2).max(80) }),
  };
  if (!schemas[kind]) return next(new BadInputError());
  const q = parse(schemas[kind], req.query);
  const { data, meta } = await nexamap("GET", `/v1/divisions/${kind}`, { query: q as Record<string, string | number>, ttlMs: 24 * 3600_000 });
  send(res, data, meta);
});

// --- routing ---

const routeSchema = z.object({
  waypoints: z.array(point).min(2).max(10),
  mode: z.enum(modes).optional(),
  avoid: z.array(z.enum(["toll", "highway", "tunnel", "unpaved", "ferry", "traffic_zone"])).optional(),
  optimize: z.boolean().optional(),
  roundtrip: z.boolean().optional(),
  depart_at: z.string().max(40).optional(),
  plate_last_digit: z.number().int().min(0).max(9).optional(),
  prefer: z.enum(["fastest", "fuel", "risk", "comfort"]).optional(),
});
export const route: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const body = parse(routeSchema, req.body);
  const { data, meta } = await nexamap("POST", "/v1/route", { body });
  send(res, data, meta);
});

export const routeExport: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const body = parse(
    z.object({
      waypoints: z.array(point).min(2).max(10),
      format: z.enum(["gpx", "geojson", "kml"]).optional(),
      mode: z.enum(modes).optional(),
      name: z.string().max(120).optional(),
    }),
    req.body,
  );
  const { data } = await nexamap<{ format: string; content: string; mime: string }>("POST", "/v1/route/export", { body });
  res.set("Content-Type", data.mime || "application/octet-stream");
  res.set("Content-Disposition", `attachment; filename="route.${data.format || body.format || "gpx"}"`);
  res.status(200).send(data.content);
});

// public matrix is kept small: one origin to at most 50 places
export const matrix: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const body = parse(
    z.object({
      sources: z.array(point).min(1).max(5),
      destinations: z.array(point).min(1).max(50),
      mode: z.enum(modes).optional(),
    }),
    req.body,
  );
  const { data, meta } = await nexamap("POST", "/v1/matrix", { body });
  send(res, data, meta);
});

export const isochrone: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const body = parse(
    z
      .object({
        origin: point,
        minutes: num.refine((v) => v > 0 && v <= 120).optional(),
        km: num.refine((v) => v > 0 && v <= 100).optional(),
        mode: z.enum(modes).optional(),
      })
      .refine((v) => v.minutes !== undefined || v.km !== undefined),
    req.body,
  );
  const { data, meta } = await nexamap("POST", "/v1/isochrone", { body, ttlMs: 30 * 60_000 });
  send(res, data, meta);
});

export const tripCost: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const body = parse(
    z.object({
      waypoints: z.array(point).min(2).max(10).optional(),
      distance_m: num.optional(),
      duration_s: num.optional(),
      mode: z.enum(modes).optional(),
      vehicle: z.object({ ev: z.boolean().optional(), kwh_per_100km: num.optional() }).optional(),
    }),
    req.body,
  );
  const { data, meta } = await nexamap("POST", "/v1/trip-cost", { body });
  send(res, data, meta);
});

// --- live layers and place intelligence ---

const bbox = z.object({ minlat: lat, minlng: lng, maxlat: lat, maxlng: lng });

export const trafficFlow: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(bbox, req.query);
  const { data, meta } = await nexamap("GET", "/v1/traffic/flow", { query: q, ttlMs: 60_000 });
  send(res, data, meta);
});

export const trafficZones: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const { data, meta } = await nexamap("GET", "/v1/traffic-zones", { ttlMs: 3600_000 });
  send(res, data, meta);
});

export const incidents: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(bbox.extend({ limit: num.refine((v) => v >= 1 && v <= 300).optional() }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/incidents", { query: q, ttlMs: 60_000 });
  send(res, data, meta);
});

export const parking: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ lat, lng, radius: num.refine((v) => v > 0 && v <= 3000).optional() }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/parking", { query: q, ttlMs: 3600_000 });
  send(res, data, meta);
});

export const airQuality: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ lat, lng }), req.query);
  const { data, meta } = await nexamap("GET", "/v1/air-quality", { query: q, ttlMs: 15 * 60_000 });
  send(res, data, meta);
});

// Everything a visitor wants to know about getting to a clinic or an
// office, in one call: its address, whether it is inside the Tehran
// traffic zone, parking around it and the air there. Each part may fail on
// its own (no data for a city) without failing the card.
export const placeInfo: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ lat, lng }), req.query);
  const at: LatLng = { lat: q.lat, lng: q.lng };
  if (!isLatLng(at)) throw new BadInputError();
  const settled = await Promise.allSettled([
    reverseGeocode(at),
    nexamap<{ count?: number; total_capacity?: number; items?: unknown[] }>("GET", "/v1/parking", {
      query: { lat: at.lat, lng: at.lng, radius: 600 },
      ttlMs: 3600_000,
    }),
    nexamap<{ value?: number; category?: string; source?: string; confidence?: number }>("GET", "/v1/air-quality", {
      query: { lat: at.lat, lng: at.lng },
      ttlMs: 15 * 60_000,
    }),
  ]);
  const [rev, park, air] = settled;
  send(res, {
    address: rev.status === "fulfilled" ? rev.value?.formatted_address ?? null : null,
    plusCode: rev.status === "fulfilled" ? rev.value?.plus_code ?? null : null,
    trafficZone: rev.status === "fulfilled" ? rev.value?.extras?.in_traffic_zone ?? null : null,
    parking:
      park.status === "fulfilled"
        ? {
            count: park.value.data.count ?? 0,
            totalCapacity: park.value.data.total_capacity ?? null,
            items: (park.value.data.items || []).slice(0, 5),
          }
        : null,
    airQuality:
      air.status === "fulfilled"
        ? {
            value: air.value.data.value ?? null,
            category: air.value.data.category ?? null,
            source: air.value.data.source ?? null,
            confidence: air.value.data.confidence ?? null,
          }
        : null,
  });
});

// Everything a form needs from one pin: address, province/city/district as
// our records (created from NexaMap's divisions when new), postal code,
// traffic zone (Lib/locatePoint.ts). Works without NexaMap too (our own
// boundaries), so it never answers "not configured".
export const locate: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q = parse(z.object({ lat, lng }), req.query);
  const { locatePoint } = await import("../Lib/locatePoint");
  send(res, await locatePoint({ lat: q.lat, lng: q.lng }));
});
