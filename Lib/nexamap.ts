import { getAppConfig } from "./appConfig";
import AppError from "./AppError";

// NexaMap client (2026-10): the one map provider of the site - tiles and
// style, geocoding, address search, divisions, routing, matrix,
// isochrones, static maps, traffic zones, parking and air quality. Every
// call goes through here, server side, so the API key never reaches a
// browser (Controllers/mapController.ts proxies what the frontend needs).
//
// Contract (docs.nexamap.ir): a success is
//   { status: "OK", request_id, data, meta: { credits_used, attribution, ... }, warnings }
// and a failure
//   { status: "ERROR", request_id, error: { code, message, message_en, field } }
// Binary endpoints (tiles, staticmap) return the raw bytes.

export const nexamapErrorCodes = [
  "INVALID_REQUEST",
  "INVALID_COORDINATE",
  "MISSING_PARAMETER",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHORIZED",
  "FORBIDDEN_ORIGIN",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "NOT_FOUND",
  "ZERO_RESULTS",
  "NO_ROUTE",
  "OUT_OF_COVERAGE",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  // ours: the integration is off or has no key
  "NOT_CONFIGURED",
] as const;
export type NexaMapErrorCode = (typeof nexamapErrorCodes)[number];

// Persian messages (translated through Lib/i18n/errorMessages.ts). The
// provider's own message is kept for the log, not shown: it may name
// fields of the provider's API rather than of our forms.
const errorText: Record<NexaMapErrorCode, string> = {
  INVALID_REQUEST: "درخواست نقشه نامعتبر است",
  INVALID_COORDINATE: "مختصات واردشده نامعتبر است",
  MISSING_PARAMETER: "اطلاعات لازم برای نقشه کامل نیست",
  PAYLOAD_TOO_LARGE: "تعداد نقاط درخواست بیش از حد مجاز است",
  UNAUTHORIZED: "کلید سرویس نقشه نامعتبر است",
  FORBIDDEN_ORIGIN: "دسترسی به سرویس نقشه از این دامنه مجاز نیست",
  QUOTA_EXCEEDED: "سهمیه‌ی سرویس نقشه تمام شده است",
  RATE_LIMITED: "درخواست‌های نقشه زیاد است؛ کمی بعد دوباره تلاش کنید",
  NOT_FOUND: "مکانی پیدا نشد",
  ZERO_RESULTS: "مکانی پیدا نشد",
  NO_ROUTE: "مسیری بین این دو نقطه پیدا نشد",
  OUT_OF_COVERAGE: "این نقطه خارج از پوشش نقشه است",
  INTERNAL_ERROR: "سرویس نقشه با خطا روبه‌رو شد",
  SERVICE_UNAVAILABLE: "سرویس نقشه در دسترس نیست",
  NOT_CONFIGURED: "سرویس نقشه هنوز راه‌اندازی نشده است",
};

const statusOf: Partial<Record<NexaMapErrorCode, number>> = {
  NOT_FOUND: 404,
  ZERO_RESULTS: 404,
  NO_ROUTE: 404,
  OUT_OF_COVERAGE: 422,
  INVALID_COORDINATE: 400,
  INVALID_REQUEST: 400,
  MISSING_PARAMETER: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 503,
  UNAUTHORIZED: 503,
  FORBIDDEN_ORIGIN: 503,
  INTERNAL_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  NOT_CONFIGURED: 503,
};

export class NexaMapError extends AppError {
  code: NexaMapErrorCode;
  field?: string;
  requestId?: string;
  constructor(code: string, detail?: { field?: string; requestId?: string; providerMessage?: string }) {
    const known = (nexamapErrorCodes as readonly string[]).includes(code)
      ? (code as NexaMapErrorCode)
      : "INTERNAL_ERROR";
    super(errorText[known], statusOf[known] ?? 502);
    this.code = known;
    this.field = detail?.field;
    this.requestId = detail?.requestId;
    if (detail?.providerMessage)
      console.warn(`[nexamap] ${known}${detail.requestId ? ` ${detail.requestId}` : ""}: ${detail.providerMessage}`);
  }
}

export type NexaMapMeta = {
  processing_time_ms?: number;
  credits_used?: number;
  data_version?: string;
  attribution?: string;
};

export type NexaMapResult<T> = {
  data: T;
  meta: NexaMapMeta;
  warnings: unknown[];
  requestId?: string;
};

type Settings = { enabled: boolean; baseUrl: string; apiKey: string; dayStyle: string; nightStyle: string };

// AppConfig is re-read at most every few seconds: a key the admin just saved
// works right away, and a page full of map calls doesn't hit Mongo each time.
let settingsCache: { at: number; value: Settings } | null = null;

// NexaMap's own panel gives the base as "https://nexamap.ir/v1" (requests go
// to <base>/<endpoint>); every path here already starts with /v1, so a base
// typed with /v1 (or a trailing slash) is reduced to the host. The default is
// the address NexaMap documents (2026-10; "api.nexamap.ir" was a guess).
export const NEXAMAP_DEFAULT_BASE = "https://nexamap.ir";
export const normalizeNexaMapBase = (value?: string | null) =>
  String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "") || NEXAMAP_DEFAULT_BASE;
export const getNexaMapSettings = async (): Promise<Settings> => {
  if (settingsCache && Date.now() - settingsCache.at < 5000) return settingsCache.value;
  const config = await getAppConfig();
  const apiKey = config.nexamapApiKey || process.env.NEXAMAP_API_KEY || "";
  const value: Settings = {
    enabled: !!config.nexamapEnabled && !!apiKey,
    baseUrl: normalizeNexaMapBase(config.nexamapBaseUrl || process.env.NEXAMAP_BASE_URL),
    apiKey,
    dayStyle: config.nexamapDefaultStyle || "day",
    nightStyle: config.nexamapDarkStyle || "night",
  };
  settingsCache = { at: Date.now(), value };
  return value;
};
export const clearNexaMapSettingsCache = () => {
  settingsCache = null;
};

// The latest quota headers NexaMap sent, for the admin status card.
export const nexamapUsage: {
  limit?: number;
  remaining?: number;
  reset?: string;
  dataVersion?: string;
  lastCreditsUsed?: number;
  creditsSinceBoot: number;
  callsSinceBoot: number;
  errorsSinceBoot: number;
  lastError?: { code: string; at: string };
} = { creditsSinceBoot: 0, callsSinceBoot: 0, errorsSinceBoot: 0 };

const readHeaders = (res: Response) => {
  const num = (name: string) => {
    const v = res.headers.get(name);
    return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  nexamapUsage.limit = num("x-ratelimit-limit") ?? nexamapUsage.limit;
  nexamapUsage.remaining = num("x-ratelimit-remaining") ?? nexamapUsage.remaining;
  nexamapUsage.reset = res.headers.get("x-ratelimit-reset") || nexamapUsage.reset;
  nexamapUsage.dataVersion = res.headers.get("x-data-version") || nexamapUsage.dataVersion;
  const credits = num("x-credits-used");
  if (credits != null) {
    nexamapUsage.lastCreditsUsed = credits;
    nexamapUsage.creditsSinceBoot += credits;
  }
};

// A small TTL cache for answers that don't change minute to minute
// (geocoding, divisions, places, static maps): saves credits and keeps a
// clinic page from paying for the same lookup on every visit.
type CacheEntry = { at: number; ttl: number; value: unknown };
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 5000;
const cacheGet = <T>(key: string): T | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
};
const cacheSet = (key: string, value: unknown, ttl: number) => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttl, value });
};

const TIMEOUT_MS = 10_000;

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

const buildUrl = (settings: Settings, path: string, query?: Query) => {
  const url = new URL(`${settings.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }
  url.searchParams.set("key", settings.apiKey);
  return url;
};

const send = async (settings: Settings, method: "GET" | "POST", url: URL, body?: unknown) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  nexamapUsage.callsSinceBoot += 1;
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "X-API-Key": settings.apiKey,
        Accept: "application/json",
        "Accept-Language": "fa",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    nexamapUsage.errorsSinceBoot += 1;
    nexamapUsage.lastError = { code: "SERVICE_UNAVAILABLE", at: new Date().toISOString() };
    throw new NexaMapError("SERVICE_UNAVAILABLE", { providerMessage: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
};

const fail = (code: string, detail?: ConstructorParameters<typeof NexaMapError>[1]) => {
  nexamapUsage.errorsSinceBoot += 1;
  nexamapUsage.lastError = { code, at: new Date().toISOString() };
  return new NexaMapError(code, detail);
};

const ensureEnabled = async () => {
  const settings = await getNexaMapSettings();
  if (!settings.enabled) throw new NexaMapError("NOT_CONFIGURED");
  return settings;
};

// One JSON call. `ttlMs` caches a GET answer (never a POST unless asked:
// routes depend on the departure time).
export const nexamap = async <T = unknown>(
  method: "GET" | "POST",
  path: string,
  options: { query?: Query; body?: unknown; ttlMs?: number } = {},
): Promise<NexaMapResult<T>> => {
  const settings = await ensureEnabled();
  const url = buildUrl(settings, path, options.query);
  const cacheKey = options.ttlMs
    ? `${method} ${url.pathname}?${[...url.searchParams].filter(([k]) => k !== "key").map(([k, v]) => `${k}=${v}`).sort().join("&")} ${options.body ? JSON.stringify(options.body) : ""}`
    : "";
  if (cacheKey) {
    const hit = cacheGet<NexaMapResult<T>>(cacheKey);
    if (hit) return hit;
  }
  const res = await send(settings, method, url, options.body);
  readHeaders(res);
  let json: {
    status?: string;
    request_id?: string;
    data?: T;
    meta?: NexaMapMeta;
    warnings?: unknown[];
    error?: { code?: string; message?: string; message_en?: string; field?: string };
  };
  try {
    json = await res.json();
  } catch {
    throw fail(res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR", {
      providerMessage: `HTTP ${res.status} non-JSON`,
    });
  }
  if (json.status !== "OK" || !res.ok) {
    throw fail(json.error?.code || (res.status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR"), {
      field: json.error?.field,
      requestId: json.request_id,
      providerMessage: json.error?.message_en || json.error?.message,
    });
  }
  const result: NexaMapResult<T> = {
    data: json.data as T,
    meta: json.meta || {},
    warnings: json.warnings || [],
    requestId: json.request_id,
  };
  if (cacheKey) cacheSet(cacheKey, result, options.ttlMs!);
  return result;
};

// Raw bytes (tiles, glyphs, sprites, static maps), cached in memory when
// small. Returns the provider's content type.
export const nexamapRaw = async (
  path: string,
  options: { query?: Query; ttlMs?: number } = {},
): Promise<{ status: number; body: Buffer; contentType: string; dataVersion?: string }> => {
  const settings = await ensureEnabled();
  const url = buildUrl(settings, path, options.query);
  const cacheKey = options.ttlMs
    ? `RAW ${url.pathname}?${[...url.searchParams].filter(([k]) => k !== "key").map(([k, v]) => `${k}=${v}`).sort().join("&")}`
    : "";
  if (cacheKey) {
    const hit = cacheGet<{ status: number; body: Buffer; contentType: string; dataVersion?: string }>(cacheKey);
    if (hit) return hit;
  }
  const res = await send(settings, "GET", url);
  readHeaders(res);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  if (!res.ok && res.status !== 204) {
    let code = res.status === 429 ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE";
    if (contentType.includes("json")) {
      try {
        const json = await res.json();
        code = json?.error?.code || code;
      } catch {
        // keep the status-derived code
      }
    }
    throw fail(code, { providerMessage: `HTTP ${res.status} ${url.pathname}` });
  }
  const body = Buffer.from(await res.arrayBuffer());
  const out = { status: res.status, body, contentType, dataVersion: res.headers.get("x-data-version") || undefined };
  if (cacheKey && body.length < 512 * 1024) cacheSet(cacheKey, out, options.ttlMs!);
  return out;
};

export type LatLng = { lat: number; lng: number };

export const isLatLng = (v: unknown): v is LatLng =>
  !!v &&
  typeof v === "object" &&
  Number.isFinite((v as LatLng).lat) &&
  Number.isFinite((v as LatLng).lng) &&
  Math.abs((v as LatLng).lat) <= 90 &&
  Math.abs((v as LatLng).lng) <= 180;

// GeoJSON [lng, lat] -> {lat, lng}
export const fromCoordinates = (coords?: unknown): LatLng | null => {
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const [lng, lat] = coords.map(Number);
  return isLatLng({ lat, lng }) ? { lat, lng } : null;
};

// --- typed helpers used by the rest of the backend ---

export type DivisionRef = { id: string; name: string; name_en?: string | null; admin_level?: string };

export const resolveDivisions = async (point: LatLng) =>
  (
    await nexamap<{ province: DivisionRef | null; city: DivisionRef | null; district: DivisionRef | null }>(
      "GET",
      "/v1/divisions/resolve",
      { query: { lat: point.lat, lng: point.lng }, ttlMs: 24 * 3600_000 },
    )
  ).data;

export type ReverseResult = {
  place_id?: string;
  formatted_address?: string;
  components?: Record<string, string>;
  plus_code?: string;
  extras?: { timezone?: string; in_traffic_zone?: string };
};

export const reverseGeocode = async (point: LatLng, lang: "fa" | "en" = "fa") =>
  (
    await nexamap<{ results: ReverseResult[] }>("GET", "/v1/reverse", {
      query: { lat: point.lat, lng: point.lng, lang },
      ttlMs: 24 * 3600_000,
    })
  ).data.results?.[0] ?? null;

export type MatrixResult = {
  distances: (number | null)[][];
  durations: (number | null)[][];
};

// Travel time/distance from one origin to many places, in chunks that stay
// under the 2500-cell limit.
export const travelFrom = async (origin: LatLng, destinations: LatLng[], mode = "car") => {
  const out: { distance_m: number | null; duration_s: number | null }[] = [];
  for (let i = 0; i < destinations.length; i += 2000) {
    const chunk = destinations.slice(i, i + 2000);
    const { data } = await nexamap<MatrixResult>("POST", "/v1/matrix", {
      body: { sources: [origin], destinations: chunk, mode },
    });
    chunk.forEach((_, j) =>
      out.push({ distance_m: data.distances?.[0]?.[j] ?? null, duration_s: data.durations?.[0]?.[j] ?? null }),
    );
  }
  return out;
};
