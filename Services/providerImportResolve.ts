import { Types } from "mongoose";
import { divisionsForPoint, normalizeGeoName } from "../Lib/geoFromPoint";
import { MappingOptions, MappingRule } from "../Lib/providerImport/mapping";
import { CleanRecord, Issue } from "../Lib/providerImport/native";
import {
  addressPrefixNames,
  buildCatalogIndex,
  CatalogIndex,
  faLetters,
  LearntNames,
  matchKey,
  nameVariants,
  parseSpecialityTitle,
  similarity,
  SpecialityLevel,
  splitJoined,
  splitLearnt,
} from "../Lib/providerImport/textExtract";
import Speciality from "../Models/Speciality";
import Disease from "../Models/Disease";
import ServiceCategory from "../Models/ServiceCategory";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";

// Bulk provider import: a mapped doctor's names -> our catalogue entries
// (2026-10). Shared by the live preview's value-map step, the dry run and
// the run, so all three agree:
//  - specialities: «تخصص X» / «فوق تخصص X» / «فلوشیپ X» / «A-B» parsed, the
//    main one is the specialist part, fellowships and subspecialities are
//    extra ones. A name found as is (or as a translation, or without its
//    parentheses) is used; one with nothing near is created. A near one is
//    only suggested in the value-map step - except with `autoCreate` (the
//    built-in partner templates), where it is created unless it is nearly
//    the same name;
//  - conditions and services written as names joined by spaces are split
//    by the longest catalogue name first; what is left is offered in the
//    value-map step (create / map / split by hand / skip) - or, with
//    `autoCreate`, split by the names the file itself repeats
//    (textExtract.ts learnJoinedNames) and created at once;
//  - the city: the map pin (Lib/geoFromPoint.ts, NexaMap), else the
//    address's leading names («یزد-...») when there is no pin; a pin and an
//    address that disagree are reported.

export const SKIP = "__skip__";
export const CREATE = "__create__";

type Entry = { _id: Types.ObjectId; name: string; slug?: string; level?: string; active?: boolean };
type Geo = { _id: Types.ObjectId; name: string; province?: Types.ObjectId };

export type Catalogues = {
  specialities: Entry[];
  specialityKeys: Map<string, Entry>;
  diseases: CatalogIndex;
  services: CatalogIndex;
  ids: Map<string, Entry>;
  provinces: Geo[];
  cities: Geo[];
  geoNames: Map<string, string>;
};

const LEVEL_WORDS = /(فوق[\s‌]*تخصص|فلوشیپ|متخصص|تخصص|دکترای|دکتری)/g;
const keyOfSpeciality = (s: string) => matchKey(faLetters(s).replace(LEVEL_WORDS, ""));

const translationNames = (row: { translations?: Record<string, Record<string, unknown> | undefined> }, field: string) =>
  Object.values(row.translations || {})
    .map((t) => t?.[field])
    .filter((v): v is string => typeof v === "string" && !!v.trim());

export const loadCatalogues = async (): Promise<Catalogues> => {
  const [specs, diseases, services, provinces, cities] = await Promise.all([
    Speciality.find().select("name slug level active translations").lean<any[]>(),
    Disease.find().select("name translations").lean<any[]>(),
    ServiceCategory.find({ isActive: true }).select("title translations").lean<any[]>(),
    Province.find().select("name").lean<any[]>(),
    City.find().select("name province").lean<any[]>(),
  ]);
  const ids = new Map<string, Entry>();
  const specialities: Entry[] = specs
    .filter((s) => s.name)
    .map((s) => ({ _id: s._id, name: s.name, slug: s.slug, level: s.level, active: s.active }));
  const specialityKeys = new Map<string, Entry>();
  // active entries win a shared key
  for (const s of [...specialities].sort((a, b) => Number(!!b.active) - Number(!!a.active))) {
    ids.set(String(s._id), s);
    const raw = specs.find((x) => String(x._id) === String(s._id));
    for (const n of [s.name, ...translationNames(raw, "name")])
      for (const v of nameVariants(n))
        for (const k of [matchKey(v), keyOfSpeciality(v)]) if (k.length >= 2 && !specialityKeys.has(k)) specialityKeys.set(k, s);
  }
  const index = (rows: any[], field: string) => {
    for (const r of rows) if (r[field]) ids.set(String(r._id), { _id: r._id, name: r[field] });
    return buildCatalogIndex(rows.filter((r) => r[field]).map((r) => ({ id: String(r._id), name: r[field], aliases: translationNames(r, field) })));
  };
  const geoNames = new Map<string, string>();
  for (const g of [...provinces, ...cities]) geoNames.set(String(g._id), g.name);
  return {
    specialities,
    specialityKeys,
    diseases: index(diseases, "name"),
    services: index(services, "title"),
    ids,
    provinces: provinces.filter((p) => p.name),
    cities: cities.filter((c) => c.name),
    geoNames,
  };
};

// a value map entry for a name (the admin's choice in the value-map step)
const choiceFor = (map: Record<string, string> | undefined, value: string) => {
  if (!map) return undefined;
  const key = matchKey(value);
  for (const [from, to] of Object.entries(map)) if (matchKey(from) === key) return to;
  return undefined;
};

// ------------------------------------------------------------ specialities

export type SpecialityPick = {
  name: string;
  level?: SpecialityLevel;
  status: "existing" | "new" | "suggest" | "skip";
  to?: Entry;
  suggestion?: Entry;
  // the name a new entry is created with
  createName?: string;
  // the admin chose «ساخت تازه» (or a new name) in the value-map step: the
  // only way an import adds a speciality (2026-10); any other unknown name
  // waits in the clean-up queue (Services/catalogCleanup.ts suggestName)
  explicit?: boolean;
};

const exactSpeciality = (name: string, cat: Catalogues): Entry | undefined => {
  for (const v of nameVariants(name)) {
    const hit = cat.specialityKeys.get(matchKey(v)) || cat.specialityKeys.get(keyOfSpeciality(v));
    if (hit) return hit;
  }
  return undefined;
};

const nearestSpeciality = (name: string, cat: Catalogues, min = 0.6): Entry | undefined => {
  let best: { e: Entry; score: number } | undefined;
  for (const e of cat.specialities) {
    const score = Math.max(...nameVariants(name).map((v) => similarity(v, e.name)));
    if (score >= min && (!best || score > best.score || (score === best.score && e.active && !best.e.active))) best = { e, score };
  }
  return best?.e;
};

export const resolveSpecialities = (
  rec: CleanRecord,
  rules: Record<string, MappingRule>,
  cat: Catalogues,
  options?: MappingOptions,
): { main?: SpecialityPick; extra: SpecialityPick[]; all: SpecialityPick[] } => {
  const raws = [rec.data.mainSpeciality, ...((rec.data.specialities as string[]) || [])].filter((v): v is string => typeof v === "string" && !!v.trim());
  const map = { ...(rules.specialities?.valueMap || {}), ...(rules.mainSpeciality?.valueMap || {}) };
  const parts = raws.flatMap(parseSpecialityTitle).filter((p, i, list) => list.findIndex((o) => matchKey(o.name) === matchKey(p.name)) === i);
  const picks: SpecialityPick[] = parts.map((p) => {
    const choice = choiceFor(map, p.name);
    if (choice === SKIP) return { name: p.name, level: p.level, status: "skip" };
    if (choice === CREATE) return { name: p.name, level: p.level, status: "new", createName: p.name, explicit: true };
    if (choice) {
      const hit = exactSpeciality(choice, cat);
      return hit
        ? { name: p.name, level: p.level, status: "existing", to: hit }
        : { name: p.name, level: p.level, status: "new", createName: choice, explicit: true };
    }
    const hit = exactSpeciality(p.name, cat);
    if (hit) return { name: p.name, level: p.level, status: "existing", to: hit };
    const near = nearestSpeciality(p.name, cat);
    if (near && options?.autoCreate) {
      // no value-map step: only a nearly identical name is the same entry
      if (similarity(p.name, near.name) >= 0.9) return { name: p.name, level: p.level, status: "existing", to: near };
      return { name: p.name, level: p.level, status: "new", createName: p.name };
    }
    if (near) return { name: p.name, level: p.level, status: "suggest", suggestion: near };
    return { name: p.name, level: p.level, status: "new", createName: p.name };
  });
  const usable = (p?: SpecialityPick) => !!p && (p.status === "existing" || p.status === "new");
  const main = picks.find((p) => (p.level === "specialist" || p.level === undefined || p.level === "general") && usable(p)) || picks.find(usable);
  const sameAs = (a: SpecialityPick, b: SpecialityPick) =>
    (a.to && b.to && String(a.to._id) === String(b.to._id)) || (!a.to && !b.to && matchKey(a.createName || a.name) === matchKey(b.createName || b.name));
  const extra = picks.filter((p) => usable(p) && !(main && sameAs(p, main)));
  return { main, extra, all: picks };
};

// ------------------------------------------------------------ joined lists

export type ListPick = {
  matched: Entry[];
  // names the admin chose to add to the catalogue
  create: string[];
  // left over and not decided yet: offered in the value-map step
  unknown: string[];
  skipped: string[];
};

export const resolveList = (
  items: unknown,
  rule: MappingRule | undefined,
  index: CatalogIndex,
  cat: Catalogues,
  auto?: { learnt?: LearntNames },
): ListPick => {
  const out: ListPick = { matched: [], create: [], unknown: [], skipped: [] };
  const list = (Array.isArray(items) ? items : typeof items === "string" ? [items] : []).filter((v): v is string => typeof v === "string" && !!v.trim());
  if (!list.length) return out;
  const add = (id: string) => {
    const e = cat.ids.get(id);
    if (e && !out.matched.some((m) => String(m._id) === id)) out.matched.push(e);
  };
  const exact = (name: string) => index.byKey.get(matchKey(name));
  let leftovers: string[] = [];
  // a built-in partner template: split with the catalogue and the names the
  // file repeats, whatever the catalogue lacks is added at once
  if (auto?.learnt && rule?.extract === "joinedList") {
    for (const part of splitLearnt(list.join(" "), auto.learnt, index)) {
      const hit = exact(part);
      if (hit) add(hit.id);
      else if (!out.create.some((c) => matchKey(c) === matchKey(part))) out.create.push(faLetters(part).trim());
    }
    return out;
  }
  if (rule?.extract === "joinedList") {
    const r = splitJoined(list.join(" "), index);
    r.matched.forEach((m) => add(m.id));
    leftovers = r.leftovers;
  } else
    for (const item of list) {
      const hit = exact(item);
      if (hit) add(hit.id);
      else leftovers.push(item);
    }
  for (const left of leftovers) {
    if (auto) {
      if (!out.create.some((c) => matchKey(c) === matchKey(left))) out.create.push(faLetters(left).trim());
      continue;
    }
    const choice = choiceFor(rule?.valueMap, left);
    if (choice === SKIP) out.skipped.push(left);
    else if (choice === CREATE) out.create.push(faLetters(left).trim());
    else if (choice) {
      // «A | B»: the admin split it by hand
      for (const part of choice.split("|").map((p) => p.trim()).filter(Boolean)) {
        const hit = exact(part);
        if (hit) add(hit.id);
        else if (!out.create.includes(part)) out.create.push(faLetters(part));
      }
    } else out.unknown.push(left);
  }
  return out;
};

// ------------------------------------------------------------ place

export type PlacePick = {
  province?: Types.ObjectId;
  city?: Types.ObjectId;
  by?: "point" | "address";
  provinceName?: string;
  cityName?: string;
  // what the address said, when it disagrees with the pin
  conflict?: { point: string; address: string };
};

const byName = (list: Geo[], name: string, province?: Types.ObjectId) => {
  const key = normalizeGeoName(name);
  if (!key) return undefined;
  return list.find((g) => normalizeGeoName(g.name) === key && (!province || String(g.province) === String(province)));
};

export const placeFromText = (address: unknown, cat: Catalogues): PlacePick | undefined => {
  const names = addressPrefixNames(address);
  if (!names.length) return undefined;
  const province = byName(cat.provinces, names[0]);
  if (province) {
    // «یزد-...»: the province's centre has its name
    const city = names[1] ? byName(cat.cities, names[1], province._id) : byName(cat.cities, names[0], province._id);
    return { province: province._id, city: city?._id, by: "address" };
  }
  const city = byName(cat.cities, names[0]);
  return city ? { province: city.province, city: city._id, by: "address" } : undefined;
};

const named = (p: PlacePick, cat: Catalogues): PlacePick => ({
  ...p,
  provinceName: p.province ? cat.geoNames.get(String(p.province)) : undefined,
  cityName: p.city ? cat.geoNames.get(String(p.city)) : undefined,
});

// the record's province / city and where they came from
export const resolvePlace = async (rec: CleanRecord, cat: Catalogues, issues: Issue[], cache: Map<string, PlacePick>): Promise<PlacePick | undefined> => {
  const d = rec.data;
  const fromAddress = placeFromText(d.address, cat);
  let point: PlacePick | undefined;
  if (d.lat !== undefined && d.lng !== undefined) {
    const key = `${Number(d.lat).toFixed(4)},${Number(d.lng).toFixed(4)}`;
    point = cache.get(key);
    if (!point) {
      const g = await divisionsForPoint({ lat: d.lat, lng: d.lng }).catch(() => ({}) as Record<string, undefined>);
      point = g.province || g.city ? { province: g.province, city: g.city, by: "point" } : { by: undefined };
      cache.set(key, point);
    }
    if (!point.province && !point.city) point = undefined;
  }
  const chosen = point || fromAddress;
  if (!chosen) return undefined;
  const result = named(chosen, cat);
  // a pin and an address naming different places: one of them is wrong
  if (point && fromAddress) {
    const pointPlace = named(point, cat);
    const addr = named(fromAddress, cat);
    const provinceDiffers = point.province && fromAddress.province && String(point.province) !== String(fromAddress.province);
    const cityDiffers = point.city && fromAddress.city && String(point.city) !== String(fromAddress.city);
    if (provinceDiffers || cityDiffers) {
      result.conflict = {
        point: [pointPlace.provinceName, pointPlace.cityName].filter(Boolean).join(" / "),
        address: [addr.provinceName, addr.cityName].filter(Boolean).join(" / "),
      };
      issues.push({
        level: "warning",
        path: rec.path,
        field: "point",
        code: "موقعیت روی نقشه («${1}») با شهرِ نشانی («${2}») یکی نیست؛ موقعیت نقشه به کار رفت، بررسی کنید",
        params: [result.conflict.point, result.conflict.address],
      });
    }
  }
  if (!result.city && !result.province) return undefined;
  return result;
};
