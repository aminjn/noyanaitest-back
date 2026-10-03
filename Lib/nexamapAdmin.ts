import crypto from "crypto";
import mongoose, { Model } from "mongoose";
import Province, { IPolygon, IPosition } from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import Office from "../Models/Office";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";
import DoctorProfile from "../Models/DoctorProfile";
import { DivisionRef, isLatLng, LatLng, nexamap, NexaMapError } from "./nexamap";
import { clearGeoCandidateCache, fillDivisions, GeoFieldMap, normalizeGeoName } from "./geoFromPoint";

// Super-admin jobs on NexaMap data (2026-10): importing the country's
// divisions into our Province / City / District records, and finding map
// pins for providers that only have a typed address. Both are long, so they
// run in the background and the admin page polls their progress. Jobs live
// in memory: a restart forgets them (they are safe to start again - nothing
// is deleted, and a second run only fills what the first left).

export type MapJobKind = "divisions" | "geocode";
export type MapJob = {
  id: string;
  kind: MapJobKind;
  status: "running" | "done" | "failed";
  phase: string;
  total: number;
  processed: number;
  startedAt: string;
  finishedAt?: string;
  error?: { code?: string; message: string };
  options: Record<string, unknown>;
  result?: unknown;
};

const jobs = new Map<string, MapJob>();
const latestByKind = new Map<MapJobKind, string>();

export const getMapJob = (kind: MapJobKind) => {
  const id = latestByKind.get(kind);
  return id ? jobs.get(id) || null : null;
};

const startJob = (
  kind: MapJobKind,
  options: Record<string, unknown>,
  run: (job: MapJob) => Promise<unknown>,
): MapJob => {
  const running = getMapJob(kind);
  if (running?.status === "running") return running;
  const job: MapJob = {
    id: crypto.randomUUID(),
    kind,
    status: "running",
    phase: "starting",
    total: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    options,
  };
  // keep only the last few jobs of each kind
  if (jobs.size > 20) {
    for (const [id, old] of jobs) if (old.status !== "running" && latestByKind.get(old.kind) !== id) jobs.delete(id);
  }
  jobs.set(job.id, job);
  latestByKind.set(kind, job.id);
  setImmediate(() => {
    run(job)
      .then((result) => {
        job.result = result;
        job.status = "done";
        job.phase = "done";
      })
      .catch((err: unknown) => {
        console.error(`[nexamapAdmin] ${kind} job failed`, err);
        job.status = "failed";
        job.phase = "failed";
        job.error = {
          code: err instanceof NexaMapError ? err.code : undefined,
          message: (err as Error)?.message || String(err),
        };
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
  });
  return job;
};

// --- geometry ---

const ringArea = (ring: IPosition[]) => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(sum / 2);
};

const cleanRing = (ring: unknown): IPosition[] | null => {
  if (!Array.isArray(ring)) return null;
  const points = ring
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [Number(p[0]), Number(p[1])] as IPosition)
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90);
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  return points.length >= 4 ? points : null;
};

const cleanPolygon = (rings: unknown): IPosition[][] | null => {
  if (!Array.isArray(rings)) return null;
  const outer = cleanRing(rings[0]);
  if (!outer) return null;
  return [outer, ...rings.slice(1).map(cleanRing).filter((r): r is IPosition[] => !!r)];
};

// Our Geo records hold one Polygon: a MultiPolygon (a province with
// islands) keeps its largest part.
export const toPolygon = (geometry: unknown): IPolygon | null => {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown; geometry?: unknown };
  if (g.type === "Feature") return toPolygon(g.geometry);
  if (g.type === "Polygon") {
    const rings = cleanPolygon(g.coordinates);
    return rings ? { type: "Polygon", coordinates: rings } : null;
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const polygons = g.coordinates.map(cleanPolygon).filter((p): p is IPosition[][] => !!p);
    if (!polygons.length) return null;
    const largest = polygons.reduce((a, b) => (ringArea(b[0]) > ringArea(a[0]) ? b : a));
    return { type: "Polygon", coordinates: largest };
  }
  return null;
};

// --- divisions sync ---

type TreeDivision = DivisionRef & {
  geometry?: unknown;
  cities?: TreeDivision[];
  districts?: TreeDivision[];
};

type Kind = "province" | "city" | "district";
type Counts = { matched: number; created: number; updated: number; skipped: number };
const emptyCounts = (): Counts => ({ matched: 0, created: 0, updated: 0, skipped: 0 });

const asList = (value: unknown, key: string): TreeDivision[] => {
  const list = Array.isArray(value) ? value : (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? (list.filter((el) => el && typeof el === "object") as TreeDivision[]) : [];
};

// The tree in one call; when it is too big to arrive in time, level by level.
const fetchDivisionTree = async (job: MapJob): Promise<TreeDivision[]> => {
  job.phase = "fetching";
  try {
    const { data } = await nexamap<{ provinces?: TreeDivision[] }>("GET", "/v1/divisions/tree", {
      query: { geometry: true },
    });
    const provinces = asList(data, "provinces");
    if (provinces.length) return provinces;
  } catch (err) {
    if (!(err instanceof NexaMapError) || !["SERVICE_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "NOT_FOUND"].includes(err.code))
      throw err;
  }
  job.phase = "fetchingByLevel";
  const provinces = asList((await nexamap("GET", "/v1/divisions/provinces", { query: { geometry: true } })).data, "provinces");
  job.total = provinces.length;
  for (const province of provinces) {
    province.cities = asList(
      (await nexamap("GET", "/v1/divisions/cities", { query: { province: province.id, geometry: true } })).data,
      "cities",
    );
    for (const city of province.cities) {
      city.districts = asList(
        (await nexamap("GET", "/v1/divisions/districts", { query: { city: city.id, geometry: true } })).data,
        "districts",
      );
    }
    job.processed += 1;
  }
  return provinces;
};

type LocalGeo = {
  _id: mongoose.Types.ObjectId;
  name?: string;
  nexamapId?: string;
  parent?: string;
  hasGeometry: boolean;
};

const modelOf = (kind: Kind) => (kind === "province" ? Province : kind === "city" ? City : District) as unknown as Model<any>;
const parentField = (kind: Kind) => (kind === "city" ? "province" : kind === "district" ? "city" : undefined);

const loadLocal = async (kind: Kind): Promise<LocalGeo[]> => {
  const parent = parentField(kind);
  return modelOf(kind).aggregate<LocalGeo>([
    {
      $project: {
        name: 1,
        nexamapId: 1,
        parent: parent ? { $toString: `$${parent}` } : null,
        hasGeometry: { $gt: [{ $size: { $ifNull: ["$geometry.coordinates", []] } }, 0] },
      },
    },
  ]);
};

export const startDivisionsSync = (options: { replaceGeometry: boolean }) =>
  startJob("divisions", options, async (job) => {
    const tree = await fetchDivisionTree(job);
    const local: Record<Kind, LocalGeo[]> = {
      province: await loadLocal("province"),
      city: await loadLocal("city"),
      district: await loadLocal("district"),
    };
    const counts: Record<Kind, Counts> = { province: emptyCounts(), city: emptyCounts(), district: emptyCounts() };
    let geometryErrors = 0;
    const problems: { kind: Kind; name: string; reason: string }[] = [];

    job.phase = "importing";
    job.processed = 0;
    job.total = tree.reduce(
      (sum, p) => sum + 1 + (p.cities || []).reduce((s, c) => s + 1 + (c.districts || []).length, 0),
      0,
    );

    const upsert = async (kind: Kind, ref: TreeDivision, parent?: mongoose.Types.ObjectId) => {
      job.processed += 1;
      const id = ref.id ? String(ref.id) : "";
      const name = typeof ref.name === "string" ? ref.name.trim() : "";
      if (!id && !name) {
        counts[kind].skipped += 1;
        return undefined;
      }
      if (kind !== "province" && !parent) {
        counts[kind].skipped += 1;
        return undefined;
      }
      const list = local[kind];
      const parentId = parent ? String(parent) : undefined;
      const wanted = normalizeGeoName(name);
      const found =
        (id && list.find((el) => el.nexamapId === id)) ||
        (wanted && list.find((el) => (!parentId || el.parent === parentId) && normalizeGeoName(el.name) === wanted)) ||
        undefined;
      const polygon = toPolygon(ref.geometry);
      const model = modelOf(kind);

      if (found) {
        counts[kind].matched += 1;
        const $set: Record<string, unknown> = {};
        if (id && found.nexamapId !== id) $set.nexamapId = id;
        if (polygon && (!found.hasGeometry || job.options.replaceGeometry)) $set.geometry = polygon;
        if (Object.keys($set).length) {
          try {
            await model.updateOne({ _id: found._id }, { $set });
          } catch {
            // a shape MongoDB won't index (self-intersecting): keep the id
            geometryErrors += 1;
            problems.push({ kind, name, reason: "geometry" });
            delete $set.geometry;
            if (Object.keys($set).length) await model.updateOne({ _id: found._id }, { $set }).catch(() => undefined);
          }
          if (Object.keys($set).length) counts[kind].updated += 1;
          if ($set.nexamapId) found.nexamapId = id;
          if ($set.geometry) found.hasGeometry = true;
        }
        return found._id;
      }

      if (!name) {
        counts[kind].skipped += 1;
        return undefined;
      }
      // active like a division a pin creates (Lib/locatePoint.ts): one rule
      const doc: Record<string, unknown> = { name, nexamapId: id || undefined, isActive: true };
      const pf = parentField(kind);
      if (pf) doc[pf] = parent;
      if (polygon) doc.geometry = polygon;
      let created: { _id: mongoose.Types.ObjectId } | null = null;
      try {
        created = await model.create(doc);
      } catch {
        if (polygon) {
          geometryErrors += 1;
          problems.push({ kind, name, reason: "geometry" });
          delete doc.geometry;
          created = await model.create(doc).catch(() => null);
        }
      }
      if (!created) {
        counts[kind].skipped += 1;
        problems.push({ kind, name, reason: "create" });
        return undefined;
      }
      counts[kind].created += 1;
      list.push({ _id: created._id, name, nexamapId: id || undefined, parent: parentId, hasGeometry: !!doc.geometry });
      return created._id;
    };

    for (const province of tree) {
      const provinceId = await upsert("province", province);
      for (const city of province.cities || []) {
        const cityId = await upsert("city", city, provinceId);
        for (const district of city.districts || []) await upsert("district", district, cityId);
      }
    }
    clearGeoCandidateCache();
    return { counts, geometryErrors, problems: problems.slice(0, 50) };
  });

// --- batch geocode ---

const MIN_CONFIDENCE = 0.6;
const BATCH_SIZE = 500;
const MAX_PER_RUN = 3000;
const POLL_MS = 2000;
const POLL_LIMIT_MS = 15 * 60_000;

type ProviderKind = "office" | "clinic" | "hospital" | "paraClinic" | "pharmacy";

const providerModels: Record<ProviderKind, { model: Model<any>; fields?: GeoFieldMap }> = {
  office: { model: Office as unknown as Model<any> },
  clinic: { model: Clinic as unknown as Model<any>, fields: { province: "province", city: "city", district: "district" } },
  hospital: { model: Hospital as unknown as Model<any>, fields: { province: "province", city: "city", district: "district" } },
  paraClinic: { model: ParaClinic as unknown as Model<any>, fields: { province: "province", city: "city", district: "district" } },
  pharmacy: { model: Pharmacy as unknown as Model<any>, fields: { province: "province", city: "city", district: "district" } },
};

// an address and no usable pin
const missingPin = {
  address: { $exists: true, $nin: [null, ""] },
  $or: [{ location: { $exists: false } }, { location: null }, { "location.coordinates.1": { $exists: false } }],
};

type Candidate = { kind: ProviderKind; id: mongoose.Types.ObjectId; name: string; address: string; query: string; doctor?: unknown };

const nameOf = (value: unknown) => (value && typeof value === "object" ? ((value as { name?: string }).name || "") : "");

// "address, city, province" - unless the address already names them
const withPlace = (address: string, ...places: string[]) => {
  const norm = normalizeGeoName(address);
  const extra = places.filter((p) => p && !norm.includes(normalizeGeoName(p)));
  return [address, ...extra].join("، ");
};

const collectCandidates = async (): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  const offices = await Office.find(missingPin)
    .select("name address doctor")
    .populate({ path: "doctor", select: "firstName lastName city province", populate: [{ path: "city", select: "name" }, { path: "province", select: "name" }] })
    .limit(MAX_PER_RUN)
    .lean<{ _id: mongoose.Types.ObjectId; name?: string; address?: string; doctor?: Record<string, unknown> }[]>();
  for (const o of offices) {
    const doctor = o.doctor || {};
    const doctorName = [doctor.firstName, doctor.lastName].filter(Boolean).join(" ");
    const address = String(o.address || "").trim();
    if (!address) continue;
    out.push({
      kind: "office",
      id: o._id,
      name: [doctorName, o.name].filter(Boolean).join(" - ") || "-",
      address,
      query: withPlace(address, nameOf(doctor.city), nameOf(doctor.province)),
      doctor: doctor._id,
    });
  }
  for (const kind of ["clinic", "hospital", "paraClinic", "pharmacy"] as const) {
    if (out.length >= MAX_PER_RUN) break;
    const rows = await providerModels[kind].model
      .find(missingPin)
      .select("name address city province")
      .populate([{ path: "city", select: "name" }, { path: "province", select: "name" }])
      .limit(MAX_PER_RUN - out.length)
      .lean<{ _id: mongoose.Types.ObjectId; name?: string; address?: string; city?: unknown; province?: unknown }[]>();
    for (const r of rows) {
      const address = String(r.address || "").trim();
      if (!address) continue;
      out.push({
        kind,
        id: r._id,
        name: r.name || "-",
        address,
        query: withPlace(address, nameOf(r.city), nameOf(r.province)),
      });
    }
  }
  return out;
};

type BatchItem = {
  index?: number;
  input?: unknown;
  status?: string;
  location?: LatLng | null;
  formatted_address?: string;
  confidence?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runBatch = async (job: MapJob, queries: string[]): Promise<BatchItem[]> => {
  const { data } = await nexamap<{ job_id?: string; id?: string; poll_url?: string }>("POST", "/v1/batch/geocode", {
    body: { addresses: queries },
  });
  const jobId = data?.job_id || data?.id;
  if (!jobId) throw new NexaMapError("INTERNAL_ERROR", { providerMessage: "batch geocode: no job id" });
  const started = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    const { data: state } = await nexamap<{
      status?: string;
      processed?: number;
      result?: { items?: BatchItem[] } | BatchItem[];
      items?: BatchItem[];
      error?: { code?: string };
    }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    const status = String(state?.status || "").toUpperCase();
    if (["DONE", "COMPLETED", "SUCCEEDED", "SUCCESS", "FINISHED"].includes(status)) {
      const items = Array.isArray(state.result) ? state.result : state.result?.items || state.items || [];
      return Array.isArray(items) ? items : [];
    }
    if (["FAILED", "ERROR", "CANCELLED", "CANCELED", "EXPIRED"].includes(status))
      throw new NexaMapError(state?.error?.code || "INTERNAL_ERROR", { providerMessage: `batch job ${jobId} ${status}` });
    if (Date.now() - started > POLL_LIMIT_MS)
      throw new NexaMapError("SERVICE_UNAVAILABLE", { providerMessage: `batch job ${jobId} timed out` });
    job.phase = `geocoding:${status.toLowerCase() || "running"}`;
  }
};

export type GeocodeRow = {
  kind: ProviderKind;
  id: string;
  // an office's doctor profile (the admin page to fix it by hand)
  doctor?: string;
  name: string;
  address: string;
  formattedAddress?: string;
  confidence?: number;
  lat?: number;
  lng?: number;
  outcome: "applied" | "preview" | "lowConfidence" | "notFound" | "changed" | "error";
};

export const startBatchGeocode = (options: { dryRun: boolean }) =>
  startJob("geocode", options, async (job) => {
    job.phase = "collecting";
    const candidates = await collectCandidates();
    job.total = candidates.length;
    const rows: GeocodeRow[] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const chunk = candidates.slice(i, i + BATCH_SIZE);
      job.phase = "geocoding";
      const items = await runBatch(job, chunk.map((c) => c.query));
      job.phase = "applying";
      for (let j = 0; j < chunk.length; j++) {
        const c = chunk[j];
        const item = items.find((el) => el?.index === j) || items[j];
        const point = item?.location;
        const confidence = typeof item?.confidence === "number" ? item.confidence : undefined;
        const row: GeocodeRow = {
          kind: c.kind,
          id: String(c.id),
          doctor: c.doctor ? String(c.doctor) : undefined,
          name: c.name,
          address: c.address,
          formattedAddress: item?.formatted_address,
          confidence,
          lat: isLatLng(point) ? point.lat : undefined,
          lng: isLatLng(point) ? point.lng : undefined,
          outcome: "notFound",
        };
        const ok = !!item && (!item.status || String(item.status).toUpperCase() === "OK") && isLatLng(point);
        if (!ok) row.outcome = "notFound";
        else if ((confidence ?? 0) < MIN_CONFIDENCE) row.outcome = "lowConfidence";
        else if (job.options.dryRun) row.outcome = "preview";
        else {
          try {
            const { model, fields } = providerModels[c.kind];
            // only while it still has no pin (an admin may have set one meanwhile)
            const res = await model.collection.updateOne(
              { _id: c.id, ...missingPin },
              { $set: { location: { type: "Point", coordinates: [point!.lng, point!.lat] } } },
            );
            if (!res.modifiedCount) row.outcome = "changed";
            else {
              row.outcome = "applied";
              if (fields) await fillDivisions(model, c.id, fields).catch(() => null);
              else if (c.kind === "office" && c.doctor)
                await fillDivisions(DoctorProfile as unknown as Model<any>, c.doctor, { province: "province", city: "city", district: "district" }, point).catch(() => null);
            }
          } catch {
            row.outcome = "error";
          }
        }
        rows.push(row);
        job.processed += 1;
      }
    }
    const summary: Record<GeocodeRow["outcome"], number> = {
      applied: 0,
      preview: 0,
      lowConfidence: 0,
      notFound: 0,
      changed: 0,
      error: 0,
    };
    rows.forEach((r) => (summary[r.outcome] += 1));
    return { total: candidates.length, minConfidence: MIN_CONFIDENCE, summary, rows };
  });
