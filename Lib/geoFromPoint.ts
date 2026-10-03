import mongoose, { Model, Schema } from "mongoose";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import {
  DivisionRef,
  fromCoordinates,
  getNexaMapSettings,
  LatLng,
  resolveDivisions,
} from "./nexamap";

// A map pin -> our province / city / district (2026-10). Like Snapp and
// Digikala, a user or provider only drops a pin: the address form no longer
// has to ask which city it is in. NexaMap names the divisions of the point
// (resolveDivisions); they map to our Geo records by the NexaMap id the
// admin divisions sync stored (nexamapId), else by the normalized Persian
// name within the parent. When NexaMap is off or down, the polygons drawn
// in our own Geo collections are used instead. Nothing here ever blocks or
// fails a save.

// Persian / Arabic spellings of the same name: ي/ك/ى, ة/ۀ, hamza forms,
// digits, ZWNJ, spaces, dashes and a leading "استان / شهرستان / شهر".
const digitMap: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (digitMap[d] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (digitMap[d] = String(i)));
export const normalizeGeoName = (value?: string | null) =>
  (value || "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ةۀ]/g, "ه")
    .replace(/[أإٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/[۰-۹٠-٩]/g, (d) => digitMap[d] || d)
    .replace(/[ً-ْـ]/g, "")
    .replace(/[‌‍‎‏]/g, " ")
    .replace(/^\s*(استان|شهرستان|شهر)\s+/, "")
    .replace(/[\s\-_.،,]+/g, "")
    .toLowerCase()
    .trim();

type GeoLean = { _id: mongoose.Types.ObjectId; name?: string; nexamapId?: string };

// Candidates per parent, kept a few minutes: a save shouldn't list every
// city of a province each time. The divisions sync clears it.
const candidateCache = new Map<string, { at: number; list: GeoLean[] }>();
const CANDIDATE_TTL = 10 * 60_000;
export const clearGeoCandidateCache = () => candidateCache.clear();

const candidates = async (kind: "province" | "city" | "district", parent?: unknown) => {
  const key = `${kind}:${parent ? String(parent) : ""}`;
  const hit = candidateCache.get(key);
  if (hit && Date.now() - hit.at < CANDIDATE_TTL) return hit.list;
  const model = (kind === "province" ? Province : kind === "city" ? City : District) as unknown as Model<GeoLean>;
  const filter = kind === "province" ? {} : kind === "city" ? { province: parent } : { city: parent };
  const list = await model.find(filter).select("_id name nexamapId").lean<GeoLean[]>();
  candidateCache.set(key, { at: Date.now(), list });
  return list;
};

// our record for one NexaMap division: by id, else by name in the parent.
// A name match learns the id, so the next lookup is direct.
export const matchDivision = async (
  kind: "province" | "city" | "district",
  ref: Pick<DivisionRef, "id" | "name"> | null | undefined,
  parent?: unknown,
): Promise<mongoose.Types.ObjectId | undefined> => {
  if (!ref || (!ref.id && !ref.name)) return undefined;
  if (kind !== "province" && !parent) return undefined;
  const list = await candidates(kind, parent);
  const id = ref.id ? String(ref.id) : "";
  const byId = id ? list.find((el) => el.nexamapId === id) : undefined;
  if (byId) return byId._id;
  const wanted = normalizeGeoName(ref.name);
  if (!wanted) return undefined;
  const byName = list.find((el) => normalizeGeoName(el.name) === wanted);
  if (!byName) return undefined;
  if (id && !byName.nexamapId) {
    const model = (kind === "province" ? Province : kind === "city" ? City : District) as unknown as Model<GeoLean>;
    await model.updateOne({ _id: byName._id, nexamapId: { $in: [null, ""] } }, { $set: { nexamapId: id } }).catch(() => undefined);
    byName.nexamapId = id;
  }
  return byName._id;
};

export type GeoIds = {
  province?: mongoose.Types.ObjectId;
  city?: mongoose.Types.ObjectId;
  district?: mongoose.Types.ObjectId;
};

// our own drawn shapes holding the point (NexaMap off or failing, or a
// division NexaMap named that we have no record for)
const fromOwnPolygons = async (point: LatLng): Promise<GeoIds & { cityProvince?: string; districtCity?: string }> => {
  const $geometry = { type: "Point", coordinates: [point.lng, point.lat] };
  const q = { geometry: { $geoIntersects: { $geometry } } };
  const [province, city, district] = await Promise.all([
    Province.findOne(q).select("_id").lean(),
    City.findOne(q).select("_id province").lean(),
    District.findOne(q).select("_id city").lean(),
  ]);
  const oid = (v: unknown) => (v ? (v as mongoose.Types.ObjectId) : undefined);
  return {
    province: oid(province?._id) || oid(city?.province),
    city: oid(city?._id) || oid(district?.city),
    district: oid(district?._id),
    cityProvince: city?.province ? String(city.province) : undefined,
    districtCity: district?.city ? String(district.city) : undefined,
  };
};

// The point's province / city / district as our record ids (any may be
// missing). Never throws.
export const divisionsForPoint = async (point: LatLng | null | undefined): Promise<GeoIds> => {
  if (!point) return {};
  let named: GeoIds = {};
  try {
    const settings = await getNexaMapSettings();
    if (settings.enabled) {
      const found = await resolveDivisions(point);
      const province = await matchDivision("province", found?.province);
      const city = await matchDivision("city", found?.city, province);
      const district = await matchDivision("district", found?.district, city);
      named = { province, city, district };
      if (province && city && district) return named;
    }
  } catch (err) {
    // NexaMap down / quota / out of coverage: our polygons below
    console.warn(`[geoFromPoint] ${(err as Error).message}`);
  }
  try {
    const own = await fromOwnPolygons(point);
    // complete what NexaMap gave with our shapes, only where they agree
    const province = named.province || own.province;
    const city =
      named.city ||
      (own.city && (!named.province || !own.cityProvince || own.cityProvince === String(named.province))
        ? own.city
        : undefined);
    const district =
      named.district ||
      (own.district && city && (!own.districtCity || own.districtCity === String(city)) ? own.district : undefined);
    return { province, city, district };
  } catch {
    return named;
  }
};

// Which fields of a model hold the divisions (path names on that schema).
export type GeoFieldMap = { province?: string; city?: string; district?: string };

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);

// Fills the empty division fields of one record from a point (its own
// location unless given). Writes through the driver so no hook re-enters.
export const fillDivisions = async (
  model: Model<any>,
  id: unknown,
  fields: GeoFieldMap,
  point?: LatLng | null,
  // the pin moved: its divisions replace the ones on record (when the point
  // resolves at all), instead of only filling empty ones
  overwrite = false,
): Promise<Record<string, unknown> | null> => {
  if (!id) return null;
  const paths = Object.values(fields).filter(Boolean) as string[];
  if (!paths.length) return null;
  const fresh = await model
    .findById(id)
    .select(["location", ...paths].join(" "))
    .lean<Record<string, unknown> & { location?: { coordinates?: unknown } }>();
  if (!fresh) return null;
  const missing = (Object.keys(fields) as (keyof GeoFieldMap)[]).filter(
    (k) => fields[k] && (overwrite || isEmpty(fresh[fields[k] as string])),
  );
  if (!missing.length) return null;
  const at = point || fromCoordinates(fresh.location?.coordinates);
  if (!at) return null;
  const found = await divisionsForPoint(at);
  // a point that resolves to nothing leaves the record as it is
  if (overwrite && !found.province) return null;
  const $set: Record<string, unknown> = {};
  for (const key of missing) if (found[key]) $set[fields[key] as string] = found[key];
  // a city / district that isn't in the province already on record is not
  // written: the record would contradict itself
  if (!missing.includes("province") && fields.province && found.province && $set[fields.city || ""]) {
    if (String(fresh[fields.province]) !== String(found.province)) {
      delete $set[fields.city as string];
      if (fields.district) delete $set[fields.district];
    }
  }
  if (!missing.includes("city") && fields.city && found.city && fields.district && $set[fields.district]) {
    if (String(fresh[fields.city]) !== String(found.city)) delete $set[fields.district];
  }
  if (!Object.keys($set).length) return null;
  await model.collection.updateOne({ _id: fresh._id as mongoose.Types.ObjectId }, { $set });
  return $set;
};

const touchesLocation = (update: unknown) => {
  if (!update || typeof update !== "object") return false;
  const u = update as Record<string, unknown>;
  const keys = [
    ...Object.keys(u),
    ...Object.keys((u.$set as object) || {}),
    ...Object.keys((u.$setOnInsert as object) || {}),
  ];
  return keys.some((k) => k === "location" || k.startsWith("location."));
};

const runLater = (task: () => Promise<unknown>) => {
  setImmediate(() => {
    task().catch((err) => console.warn(`[geoFromPoint] ${(err as Error)?.message || err}`));
  });
};

// Mongoose plugin: after a save / update that sets `location`, fill the
// record's empty division fields - or, with `target`, another record's
// (an office fills its doctor's profile). Runs after the write, in the
// background: a save is never slowed down or failed by it. Covers
// save/create, findOneAndUpdate / findByIdAndUpdate (autoRouter edits) and
// updateOne.
export const geoFromPointPlugin = (
  schema: Schema,
  options: {
    // the model the schema is registered as
    modelName: string;
    fields?: GeoFieldMap;
    // the record whose fields get filled from this one's location
    target?: (doc: Record<string, unknown>) => { model: Model<any>; id: unknown; fields: GeoFieldMap } | null;
  },
) => {
  const fill = async (id: unknown, overwrite = false) => {
    if (!id) return;
    const model = mongoose.model(options.modelName);
    if (!options.target) {
      if (options.fields) await fillDivisions(model, id, options.fields, null, overwrite);
      return;
    }
    const doc = await model.findById(id).lean<Record<string, unknown> & { location?: { coordinates?: unknown } }>();
    if (!doc) return;
    const point = fromCoordinates(doc.location?.coordinates);
    if (!point) return;
    const target = options.target(doc);
    if (target) await fillDivisions(target.model, target.id, target.fields, point);
  };

  // the pin is the source of truth for the record's own divisions: a write
  // that moves it without naming the divisions too lets the pin decide
  const divisionPaths = Object.values(options.fields || {}).filter(Boolean) as string[];
  const setsDivisions = (update: unknown) => {
    if (!update || typeof update !== "object") return false;
    const u = update as Record<string, unknown>;
    const keys = [...Object.keys(u), ...Object.keys((u.$set as object) || {})];
    return keys.some((k) => divisionPaths.includes(k));
  };
  schema.pre("save", function (next) {
    const moved = !this.isNew && this.isModified("location");
    this.$locals.geoFill = this.isNew || moved;
    this.$locals.geoOverwrite = moved && !divisionPaths.some((p) => this.isModified(p));
    next();
  });
  schema.post("save", function (doc) {
    if (doc.$locals?.geoFill) runLater(() => fill(doc._id, !!doc.$locals?.geoOverwrite));
  });
  schema.post("findOneAndUpdate", function (doc) {
    const query = this as unknown as { getUpdate: () => unknown; model: Model<unknown> };
    const update = query.getUpdate();
    if (!doc?._id || !touchesLocation(update)) return;
    runLater(() => fill(doc._id, !setsDivisions(update)));
  });
  schema.post("updateOne", { document: false, query: true }, function () {
    const query = this as unknown as { getUpdate: () => unknown; getFilter: () => object; model: Model<unknown> };
    const update = query.getUpdate();
    if (!touchesLocation(update)) return;
    const filter = query.getFilter();
    runLater(async () => {
      const found = await query.model.findOne(filter).select("_id").lean<{ _id: unknown }>();
      if (found) await fill(found._id, !setsDivisions(update));
    });
  });
};
