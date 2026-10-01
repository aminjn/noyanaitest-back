import mongoose from "mongoose";
import { fromCoordinates, getNexaMapSettings, LatLng, travelFrom } from "./nexamap";

// "Near me" by real travel time (2026-10), as Halodoc sorts nearby
// providers: a straight line across a Tehran highway or a closed street
// says little about how long the trip takes. The closest NEAREST_BY_TRAVEL
// places by straight line are re-ranked by NexaMap's car travel time; the
// rest follow by straight line. When NexaMap is off or fails, the order is
// simply by straight line and no `travel` is given.

export const NEAREST_BY_TRAVEL = 50;

export type Travel = { duration_s: number | null; distance_m: number | null };

const haversine = (a: LatLng, b: LatLng) => {
  const R = 6371000;
  const r = Math.PI / 180;
  const dlat = (b.lat - a.lat) * r;
  const dlng = (b.lng - a.lng) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// travel answers for the same origin (~100 m) and places, for a few
// minutes: paging through the same search doesn't pay for the matrix again
const cache = new Map<string, { at: number; value: Map<string, Travel> }>();
const CACHE_MS = 5 * 60_000;

export const rankByTravel = async (
  origin: LatLng,
  places: { _id: unknown; location?: { coordinates?: unknown } | null }[],
): Promise<{ order: string[]; travel: Map<string, Travel> }> => {
  const located = places
    .map((p) => {
      const point = fromCoordinates(p.location?.coordinates);
      return { id: String(p._id), point, straight: point ? haversine(origin, point) : Infinity };
    })
    .sort((a, b) => a.straight - b.straight);
  const head = located.slice(0, NEAREST_BY_TRAVEL).filter((p) => p.point);
  let travel = new Map<string, Travel>();
  if (head.length) {
    const key = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}|${head.map((p) => p.id).join(",")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) travel = hit.value;
    else {
      try {
        const settings = await getNexaMapSettings();
        if (settings.enabled) {
          const answers = await travelFrom(origin, head.map((p) => p.point as LatLng));
          head.forEach((p, i) => {
            const a = answers[i];
            if (a && (a.duration_s != null || a.distance_m != null)) travel.set(p.id, a);
          });
          if (cache.size > 500) cache.clear();
          cache.set(key, { at: Date.now(), value: travel });
        }
      } catch (err) {
        console.warn(`[nearbyTravel] ${(err as Error).message}`);
        travel = new Map();
      }
    }
  }
  const byTravel = (id: string) => travel.get(id)?.duration_s ?? Infinity;
  const ranked = located.slice(0, NEAREST_BY_TRAVEL);
  if (travel.size)
    ranked.sort((a, b) => byTravel(a.id) - byTravel(b.id) || a.straight - b.straight);
  return { order: [...ranked, ...located.slice(NEAREST_BY_TRAVEL)].map((p) => p.id), travel };
};

// One page of a ranked search: the page's ids (for a $match) and a function
// that puts the fetched rows in rank order with their travel.
export const travelPage = (
  ranked: { order: string[]; travel: Map<string, Travel> },
  page: number,
  pageSize: number,
) => {
  const ids = ranked.order.slice((page - 1) * pageSize, page * pageSize);
  return {
    ids: ids.map((id) => new mongoose.Types.ObjectId(id)),
    arrange: <T extends { _id: unknown }>(rows: T[]) =>
      rows
        .slice()
        .sort((a, b) => ids.indexOf(String(a._id)) - ids.indexOf(String(b._id)))
        .map((row) => {
          const t = ranked.travel.get(String(row._id));
          return t ? { ...row, travel: t } : row;
        }),
  };
};
