import { normalizeGeoName } from "./geoFromPoint";
import { nexamap, resolveDivisions } from "./nexamap";

// An Iranian written address to a map pin (2026-10, the owner's report:
// «میدان انقلاب، ابتدای کارگر جنوبی، نبش کوچه رشتچی، پلاک ۹۷۴» found
// nothing). NexaMap's geocoder takes the street part of an address; the
// details Iranian addresses carry (the plaque, unit, floor, «نبش کوچه…»)
// make it answer nothing or the city. So the address is tried as written,
// then without those details, then shortened from its end («…، نبش کوچه
// رشتچی» dropped, then «ابتدای کارگر جنوبی») until a match finer than the
// city comes back - inside Iran and, when the caller knows it, in the
// expected province. Every try is one cached call (Lib/nexamap.ts).
// Used by the map pickers (GET /map/geocode-address) and the bulk import.

const COARSE_MATCH = /^(country|province|state|region|county|city|town|locality)$/i;
const IRAN_BOX = { minLat: 24.8, maxLat: 39.9, minLng: 44, maxLng: 63.4 };
const MAX_TRIES = 6;

export type LatLng = { lat: number; lng: number };
export type GeocodeHit = LatLng & { query: string; matchLevel?: string };

const DIGITS: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (DIGITS[d] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (DIGITS[d] = String(i)));

const normalise = (text: string) =>
  text
    .replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d] || d)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s*[،,؛;]\s*/g, "، ")
    .replace(/\s+-\s+/g, "، ")
    .replace(/\s+/g, " ")
    .replace(/^[،\s]+|[،\s]+$/g, "")
    .trim();

// the parts of an address the geocoder has no use for
const DETAIL = /(?:^|\s)(?:پلاک|پ\.|واحد|طبقه|کد\s*پستی|کدپستی|ساختمان|برج|مجتمع|زنگ|طبقه‌ی|ط\.)\s*\S*.*$/;
// the words around a street name («ابتدای کارگر» is on «کارگر»)
const CONNECTOR = /(?:^|\s)(?:ابتدای|ابتدا|انتهای|انتها|اول|نبش|نرسیده\s+به|بعد\s+از|قبل\s+از|روبروی|روبه‌روی|روبرو|جنب|کنار|بین|حد\s+فاصل)(?=\s)/g;

// the queries to try, most precise first
export const addressVariants = (address: string, city?: string): string[] => {
  const full = normalise(address);
  if (!full) return [];
  const segments = full
    .split("، ")
    .map((s) => s.replace(DETAIL, "").trim())
    .filter(Boolean);
  const out: string[] = [full];
  // shortened down to a place of its own («میدان انقلاب»), never to a bare
  // name («تهران»: the city's centre, not a pin)
  for (let n = segments.length; n >= 1; n--) {
    const q = segments.slice(0, n).join("، ");
    if (n < segments.length && q.split(/\s+/).length < 2) break;
    out.push(q);
  }
  // the same without the connector words, for the street part
  if (segments.length >= 2) out.push(segments.slice(0, 2).join("، ").replace(CONNECTOR, " ").replace(/\s+/g, " ").trim());
  const place = city ? normalise(city) : "";
  const withCity = (q: string) => (place && !normalizeGeoName(q).includes(normalizeGeoName(place)) ? `${place}، ${q}` : q);
  const seen = new Set<string>();
  return out
    .map(withCity)
    .filter((q) => q.length >= 3 && !seen.has(q) && !!seen.add(q))
    .slice(0, MAX_TRIES);
};

type Result = { location?: { lat?: number; lng?: number }; confidence?: number; match_level?: string; match_type?: string };

const distance = (a: LatLng, b: LatLng) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180));

// the first query of addressVariants that NexaMap places finer than the
// city; `near` picks between a query's hits (the map the user is on)
export const geocodeAddress = async (
  address: string,
  opts: { province?: string; city?: string; near?: LatLng } = {},
): Promise<GeocodeHit | undefined> => {
  const want = opts.province ? normalizeGeoName(opts.province) : "";
  for (const query of addressVariants(address, opts.city)) {
    const { data } = await nexamap<{ results?: Result[] }>("GET", "/v1/geocode", {
      query: { address: query.slice(0, 300), lang: "fa" },
      ttlMs: 7 * 24 * 3600_000,
    });
    let hits = (data?.results || [])
      .filter((r) => typeof r.location?.lat === "number" && typeof r.location?.lng === "number")
      .filter((r) => !(typeof r.confidence === "number" && r.confidence < 0.5))
      .filter((r) => !COARSE_MATCH.test(String(r.match_level || r.match_type || "")))
      .map((r) => ({ lat: r.location!.lat!, lng: r.location!.lng!, query, matchLevel: r.match_level || r.match_type }))
      .filter(({ lat, lng }) => lat >= IRAN_BOX.minLat && lat <= IRAN_BOX.maxLat && lng >= IRAN_BOX.minLng && lng <= IRAN_BOX.maxLng)
      .slice(0, 5);
    if (opts.near) hits = hits.sort((a, b) => distance(a, opts.near!) - distance(b, opts.near!));
    for (const hit of hits) {
      if (!want) return hit;
      const divisions = await resolveDivisions(hit).catch(() => null);
      if (divisions?.province && normalizeGeoName(divisions.province.name) === want) return hit;
    }
  }
  return undefined;
};
