import City from "../Models/Geo/City";
import Province from "../Models/Geo/Province";
import { normalizeGeoName } from "./geoFromPoint";

// The province and city a record names in its own text (2026-10: the
// partner's Shiraz pharmacies came in as Tehran - the template had Tehran
// fixed, its first file being Tehran's). Read from where Iranian addresses
// and centre names put the place, never from the middle of a name (a city
// called «مهر» is not «داروخانه ایران مهر»):
//  - the address's leading parts: «شیراز، خیابان …», «فارس-شیراز-…»;
//  - the name's last word or two: «داروخانه آسیا شیراز».
// Matched against our own divisions (Models/Geo), so the answer is a name
// the import's matchDivision finds.

type Place = { province?: string; city?: string };
type Index = { at: number; cities: Map<string, { city: string; province: string }[]>; provinces: Map<string, string> };

let cache: Index | null = null;
const TTL = 10 * 60_000;

const index = async (): Promise<Index> => {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const provinces = await Province.find().select("_id name").lean<{ _id: unknown; name?: string }[]>();
  const nameOf = new Map(provinces.map((p) => [String(p._id), p.name || ""]));
  const cities = await City.find().select("name province").lean<{ name?: string; province?: unknown }[]>();
  const byCity = new Map<string, { city: string; province: string }[]>();
  for (const c of cities) {
    const key = normalizeGeoName(c.name);
    const province = nameOf.get(String(c.province)) || "";
    if (!key || !province) continue;
    byCity.set(key, [...(byCity.get(key) || []), { city: c.name!, province }]);
  }
  const byProvince = new Map(provinces.filter((p) => p.name).map((p) => [normalizeGeoName(p.name), p.name!]));
  cache = { at: Date.now(), cities: byCity, provinces: byProvince };
  return cache;
};
export const clearPlaceIndex = () => {
  cache = null;
};

// a city (and its province), or a province alone, a piece of text names
const lookup = (idx: Index, piece: string, province?: string): Place | undefined => {
  const key = normalizeGeoName(piece);
  if (!key) return undefined;
  const cities = idx.cities.get(key);
  if (cities?.length) {
    // a name two provinces share: the one the text also names
    const hit = (province && cities.find((c) => normalizeGeoName(c.province) === normalizeGeoName(province))) || cities[0];
    return { city: hit.city, province: hit.province };
  }
  const p = idx.provinces.get(key);
  return p ? { province: p } : undefined;
};

export const placeFromText = async (address?: string, name?: string): Promise<Place> => {
  const idx = await index();
  let found: Place = {};
  const take = (hit?: Place) => {
    if (!hit) return;
    if (hit.city && !found.city) found = { city: hit.city, province: hit.province };
    else if (hit.province && !found.province) found = { ...found, province: hit.province };
  };
  // the address's leading parts («فارس-شیراز-…»: the province, then the city)
  const parts = (address || "").split(/\s*[،,\-–]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  for (const part of parts) {
    const words = part.split(/\s+/);
    // «شیراز»، «استان فارس»، «شهر شیراز»: a short part is the place itself;
    // a longer one may start with it («شیراز خیابان زند»)
    take(lookup(idx, part, found.province) || (words.length > 1 ? lookup(idx, words[0], found.province) : undefined));
    if (found.city) return found;
  }
  // the name's tail: «داروخانه آسیا شیراز», «… بندر عباس»
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) take(lookup(idx, words.slice(-2).join(" "), found.province) || lookup(idx, words[words.length - 1], found.province));
  return found;
};
