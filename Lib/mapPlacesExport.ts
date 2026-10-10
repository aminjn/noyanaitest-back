import mongoose, { Model, PipelineStage } from "mongoose";
import Office from "../Models/Office";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";
import Insurance from "../Models/Insurance";
import DoctorProfile from "../Models/DoctorProfile";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import Speciality from "../Models/Speciality";
import ClinicCategory from "../Models/ClinicCategory";
import HospitalCategory from "../Models/HospitalCategory";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import InsuranceCategory from "../Models/InsuranceCategory";
import { getAppConfig } from "./appConfig";
import { hasWeeklyHours, HoursDay, HoursRange, hoursSummary, isRoundTheClockHours, OpeningHours } from "./openingHours";
import Comment, { isRatedPath } from "../Models/Comment";
import DoctorFeedBack, { publicDoctorFeedbackMatch } from "../Models/DoctorFeedback";
import DoctorShift from "../Models/DoctorShift";
import User from "../Models/User";
import UserIdentity from "../Models/UserIdentity";
import { locales, SOURCE_LOCALE } from "./locales";

// Super admin «خروجی مکان‌ها برای نکسا مپ» (2026-10, owner's decision): one
// JSON line per provider place whose pin is saved in NoyanAI, for a bulk
// import into NexaMap's places. Streamed from a cursor (Controllers/
// adminMapController.ts exportMapPlaces), so it scales to any count.
//
// What is exported: only what the public site already shows - a published
// (active) provider that is not suspended, has a public page (slug) and a
// map pin. A doctor's place is each of their switched-on offices (a doctor
// profile's own location is derived from them, Lib/doctorLocation.ts, so it
// is not exported twice). Never a patient, never a private number: the
// phone is the one the public page prints (office tel, centre phone).
//
// Format: our own simple schema, which NexaMap takes as is (owner, 2026-10):
// id, type, category, name (+ name_i18n), lat, lng, address (+
// address_i18n), province, city, district, phone, website, url,
// hours { timezone, week[7] { day, ranges [{ open, close }] },
// round_the_clock, text, text_en } (Tehran wall-clock; an office's hours are
// its doctor's in-person shifts there), opening_hours (the same in OSM
// syntax), rating { average, count }, reviews [{ rating, text, date,
// reviewer }] (approved public reviews only, newest first, at most
// REVIEWS_PER_PLACE; the reviewer as the site shows them - first name and
// initial, or the public username - never a phone or national id),
// updated_at. format=geojson writes the same
// properties as one GeoJSON Feature per line (RFC 8142 GeoJSON text
// sequence without the record separator, what ogr2ogr / tippecanoe read as
// GeoJSONSeq). Empty fields are left out.

export const placeKinds = ["office", "clinic", "hospital", "paraClinic", "pharmacy", "insurance"] as const;
export type PlaceKind = (typeof placeKinds)[number];

// a NexaMap / OSM-friendly category slug per kind (amenity / healthcare
// tags)
const categorySlug: Record<PlaceKind, string> = {
  office: "doctor",
  clinic: "clinic",
  hospital: "hospital",
  paraClinic: "laboratory",
  pharmacy: "pharmacy",
  insurance: "insurance_office",
};

// the public page of each kind (Components/helpers/sitemapNodeTypes.ts on
// the frontend)
const pagePath: Record<PlaceKind, string> = {
  office: "/dr/",
  clinic: "/clinic/",
  hospital: "/hospital/",
  paraClinic: "/paraClinic/",
  pharmacy: "/pharmacy/",
  insurance: "/insurance/",
};

type CentreConfig = {
  model: Model<any>;
  activeField: "active" | "isActive";
  categoryModel?: Model<any>;
  hours: boolean;
  website: boolean;
  roundTheClock?: string;
};

const centres: Record<Exclude<PlaceKind, "office">, CentreConfig> = {
  clinic: { model: Clinic as unknown as Model<any>, activeField: "active", categoryModel: ClinicCategory as unknown as Model<any>, hours: true, website: true, roundTheClock: "isRoundTheClock" },
  hospital: { model: Hospital as unknown as Model<any>, activeField: "isActive", categoryModel: HospitalCategory as unknown as Model<any>, hours: true, website: true, roundTheClock: "isRoundTheClock" },
  paraClinic: { model: ParaClinic as unknown as Model<any>, activeField: "active", categoryModel: ParaClinicCategory as unknown as Model<any>, hours: true, website: false, roundTheClock: "isRoundTheClock" },
  pharmacy: { model: Pharmacy as unknown as Model<any>, activeField: "active", hours: true, website: false, roundTheClock: "isRoundTheClock" },
  insurance: { model: Insurance as unknown as Model<any>, activeField: "active", categoryModel: InsuranceCategory as unknown as Model<any>, hours: false, website: true },
};

const hasPin = { "location.coordinates.1": { $exists: true } };
const hasSlug = { $exists: true, $nin: [null, ""] };
const notSuspended = { $ne: "suspended" };

// changed on or after `since`: updatedAt, or for a record saved before the
// models had timestamps, its creation time (the ObjectId's)
const changedSince = (since: Date, prefix = "") => [
  { [`${prefix}updatedAt`]: { $gte: since } },
  {
    [`${prefix}updatedAt`]: { $exists: false },
    [`${prefix}_id`]: { $gte: mongoose.Types.ObjectId.createFromTime(Math.floor(since.getTime() / 1000)) },
  },
];

const centreMatch = (kind: Exclude<PlaceKind, "office">, since?: Date | null) => {
  const cfg = centres[kind];
  return {
    [cfg.activeField]: true,
    status: notSuspended,
    slug: hasSlug,
    ...hasPin,
    ...(since ? { $or: changedSince(since) } : {}),
  };
};

const doctorFields = {
  _id: 1,
  firstName: 1,
  lastName: 1,
  slug: 1,
  website: 1,
  mainSpeciality: 1,
  province: 1,
  city: 1,
  district: 1,
  translations: 1,
  updatedAt: 1,
};

// a switched-on office of a published doctor
const officePipeline = (since?: Date | null): PipelineStage[] => [
  { $match: { active: true, ...hasPin } },
  {
    $lookup: {
      from: DoctorProfile.collection.name,
      localField: "doctor",
      foreignField: "_id",
      as: "d",
    },
  },
  { $unwind: "$d" },
  {
    $match: {
      "d.active": true,
      "d.status": notSuspended,
      "d.slug": hasSlug,
      ...(since ? { $or: [...changedSince(since), ...changedSince(since, "d.")] } : {}),
    },
  },
  {
    $project: {
      name: 1,
      address: 1,
      addressDetail: 1,
      tel: 1,
      location: 1,
      updatedAt: 1,
      ...Object.fromEntries(Object.keys(doctorFields).map((k) => [`d.${k}`, 1])),
    },
  },
];

export type PlacesFilter = { kinds: PlaceKind[]; since?: Date | null };

export const countPlaces = async ({ kinds, since }: PlacesFilter) => {
  const counts: Partial<Record<PlaceKind, number>> = {};
  for (const kind of kinds) {
    if (kind === "office") {
      const rows = await Office.aggregate([...officePipeline(since), { $count: "n" }]);
      counts.office = rows[0]?.n || 0;
    } else counts[kind] = await centres[kind].model.collection.countDocuments(centreMatch(kind, since));
  }
  return counts;
};

// ---------------------------------------------------------------- lines

type NameDoc = { name?: string; translations?: Record<string, Record<string, unknown>> };

// short-lived lookups (a province is shared by thousands of rows)
const makeNameCache = () => {
  const cache = new Map<string, Promise<NameDoc | null>>();
  return (model: Model<any>, id: unknown): Promise<NameDoc | null> => {
    if (!id) return Promise.resolve(null);
    const key = `${model.modelName}:${String(id)}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = model.collection
        .findOne({ _id: id as mongoose.Types.ObjectId }, { projection: { name: 1, translations: 1 } })
        .then((doc) => (doc as NameDoc | null) || null)
        .catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// { en: "...", ar: "..." } from a record's translations (the Persian value
// is the base field itself)
const i18nOf = (doc: NameDoc | null | undefined, field: string, compose?: (t: Record<string, unknown>) => string) => {
  const out: Record<string, string> = {};
  const tr = doc?.translations;
  if (!tr || typeof tr !== "object") return undefined;
  for (const loc of locales) {
    if (loc === SOURCE_LOCALE) continue;
    const part = tr[loc];
    if (!part || typeof part !== "object") continue;
    const value = compose ? compose(part) : text(part[field]);
    if (value) out[loc] = value;
  }
  return Object.keys(out).length ? out : undefined;
};

// Saturday-first days (Lib/openingHours.ts) in OpenStreetMap's
// opening_hours syntax: "Sa-We 08:00-14:00,16:00-20:00; Th 08:00-12:00",
// "24/7" when open round the clock
const OSM_DAYS = ["Sa", "Su", "Mo", "Tu", "We", "Th", "Fr"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const osmOpeningHours = (hours: unknown): string | undefined => {
  if (!hasWeeklyHours(hours)) return undefined;
  if (isRoundTheClockHours(hours)) return "24/7";
  const dayText = hours.days.map((d) =>
    (Array.isArray(d?.ranges) ? d.ranges : [])
      .filter((r: HoursRange) => typeof r?.start === "number" && typeof r?.end === "number")
      .map((r: HoursRange) => `${hhmm(r.start)}-${hhmm(r.end)}`)
      .join(","),
  );
  const rules: string[] = [];
  for (let i = 0; i < dayText.length; ) {
    let j = i;
    while (j + 1 < dayText.length && dayText[j + 1] === dayText[i]) j++;
    if (dayText[i]) rules.push(`${i === j ? OSM_DAYS[i] : `${OSM_DAYS[i]}-${OSM_DAYS[j]}`} ${dayText[i]}`);
    i = j + 1;
  }
  return rules.length ? rules.join("; ") : undefined;
};

const website = (v: unknown) => {
  const s = text(v);
  return /^https?:\/\/\S+$/i.test(s) ? s : undefined;
};

const coordsOf = (doc: { location?: { coordinates?: unknown[] } }) => {
  const c = doc.location?.coordinates;
  const lng = Number(c?.[0]);
  const lat = Number(c?.[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};

const updatedOf = (...docs: ({ _id?: unknown; updatedAt?: unknown } | null | undefined)[]) => {
  let best = 0;
  for (const doc of docs) {
    if (!doc) continue;
    const at =
      doc.updatedAt instanceof Date
        ? doc.updatedAt.getTime()
        : doc._id instanceof mongoose.Types.ObjectId
          ? doc._id.getTimestamp().getTime()
          : 0;
    if (at > best) best = at;
  }
  return best ? new Date(best).toISOString() : undefined;
};

const compact = (o: Record<string, unknown>) => {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === "" || o[k] === null) delete o[k];
  return o;
};


// ---------------------------------------------------------------- hours

const WEEK_DAYS = ["saturday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday"];

// Saturday-first days -> { timezone, week, round_the_clock, text, text_en }
const structuredHours = (hours: unknown) => {
  if (!hasWeeklyHours(hours)) return undefined;
  const week = WEEK_DAYS.map((day, i) => ({
    day,
    ranges: (Array.isArray(hours.days[i]?.ranges) ? hours.days[i].ranges : [])
      .filter((r: HoursRange) => typeof r?.start === "number" && typeof r?.end === "number")
      .map((r: HoursRange) => ({ open: hhmm(r.start), close: hhmm(r.end) })),
  }));
  if (!week.some((d) => d.ranges.length)) return undefined;
  return {
    timezone: "Asia/Tehran",
    week,
    round_the_clock: isRoundTheClockHours(hours),
    text: hoursSummary(hours, SOURCE_LOCALE) || undefined,
    text_en: hoursSummary(hours, "en") || undefined,
  };
};

// an office's weekly hours: its doctor's in-person shifts there, overlapping
// ones merged
const officeHours = async (officeId: unknown): Promise<OpeningHours | null> => {
  const shifts = await DoctorShift.collection
    .find({ office: officeId as mongoose.Types.ObjectId, sessionTypes: "inPerson" }, { projection: { day: 1, start: 1, end: 1 } })
    .toArray()
    .catch(() => []);
  if (!shifts.length) return null;
  const days: HoursDay[] = Array.from({ length: 7 }, () => ({ ranges: [] }));
  for (const sh of shifts) {
    const day = Number(sh.day);
    const start = Number(sh.start);
    const end = Number(sh.end);
    if (!(day >= 0 && day <= 6) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1440 || end <= start) continue;
    days[day].ranges.push({ start, end });
  }
  for (const d of days) {
    d.ranges.sort((a, b) => a.start - b.start);
    const merged: HoursRange[] = [];
    for (const r of d.ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    d.ranges = merged;
  }
  return days.some((d) => d.ranges.length) ? { days, exceptions: [] } : null;
};

// -------------------------------------------------------------- reviews

// the newest approved reviews written into each line (the rating counts
// every one of them)
export const REVIEWS_PER_PLACE = 100;

// a public username that is really a phone number is never written
const safeName = (v: unknown) => {
  const s = text(v);
  return s && !/\d{6,}/.test(s.replace(/[\s-]/g, "")) ? s : undefined;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

// a doctor's verified, approved feedback (the doctor page's list); the
// reviewer as that page shows them: first name and last initial
const doctorReviews = async (doctorId: mongoose.Types.ObjectId) => {
  const match = publicDoctorFeedbackMatch(doctorId);
  const [stats] = await DoctorFeedBack.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$overalScore" } } },
  ]);
  if (!stats?.count) return { rating: { average: 0, count: 0 } };
  const rows = await DoctorFeedBack.collection
    .find(match, { projection: { overalScore: 1, publicMessage: 1, submittedAt: 1, user: 1 } })
    .sort({ submittedAt: -1 })
    .limit(REVIEWS_PER_PLACE)
    .toArray();
  const ids = rows.map((r) => r.user).filter(Boolean);
  const identities = ids.length
    ? await UserIdentity.collection.find({ user: { $in: ids } }, { projection: { user: 1, givenName: 1, lastName: 1 } }).toArray()
    : [];
  return {
    rating: { average: round1(stats.average || 0), count: stats.count },
    reviews: rows.map((r) => {
      const who = identities.find((i) => String(i.user) === String(r.user));
      const last = text(who?.lastName);
      const reviewer = who ? `${text(who.givenName)} ${last ? `${last.charAt(0)}.` : ""}`.trim() : "";
      return compact({
        rating: typeof r.overalScore === "number" ? r.overalScore : undefined,
        text: text(r.publicMessage),
        date: r.submittedAt instanceof Date ? r.submittedAt.toISOString() : undefined,
        reviewer: safeName(reviewer),
      });
    }),
  };
};

// a centre's approved reviews (its page's list: verified ones on a rated
// page; an insurer's page is open Q&A, so text only and no rating); the
// reviewer as that list shows them: the public username
const centreReviews = async (modelName: string, id: mongoose.Types.ObjectId) => {
  const rated = isRatedPath(modelName);
  const match = { resource: id, refPath: modelName, status: "Approved", ...(rated ? { verified: true } : {}) };
  const [stats] = await Comment.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$score" } } },
  ]);
  if (!stats?.count) return { rating: rated ? { average: 0, count: 0 } : undefined };
  const rows = await Comment.collection
    .find(match, { projection: { score: 1, content: 1, createdAt: 1, author: 1 } })
    .sort({ createdAt: -1 })
    .limit(REVIEWS_PER_PLACE)
    .toArray();
  const ids = rows.map((r) => r.author).filter(Boolean);
  const users = ids.length ? await User.collection.find({ _id: { $in: ids } }, { projection: { username: 1 } }).toArray() : [];
  return {
    rating: rated ? { average: round1(stats.average || 0), count: stats.count } : { count: stats.count },
    reviews: rows.map((r) =>
      compact({
        rating: rated && typeof r.score === "number" ? r.score : undefined,
        text: text(r.content),
        date: r.createdAt instanceof Date ? r.createdAt.toISOString() : undefined,
        reviewer: safeName(users.find((u) => String(u._id) === String(r.author))?.username),
      }),
    ),
  };
};

export type PlaceLine = Record<string, unknown>;

const toOutput = (line: PlaceLine, format: "jsonl" | "geojson") => {
  if (format === "jsonl") return line;
  const { lat, lng, ...properties } = line;
  return { type: "Feature", id: line.id, geometry: { type: "Point", coordinates: [lng, lat] }, properties };
};

// Streams every line through `write` (which may wait for the socket to
// drain); `aborted` stops early when the client went away.
export const streamPlaces = async (
  { kinds, since, format }: PlacesFilter & { format: "jsonl" | "geojson" },
  write: (line: string) => Promise<void>,
  aborted: () => boolean,
) => {
  const base = text((await getAppConfig()).siteBaseUrl).replace(/\/+$/, "");
  const nameOf = makeNameCache();
  const geo = async (doc: Record<string, unknown>) => {
    const [p, c, d] = await Promise.all([
      nameOf(Province as unknown as Model<any>, doc.province),
      nameOf(City as unknown as Model<any>, doc.city),
      nameOf(District as unknown as Model<any>, doc.district),
    ]);
    return { province: text(p?.name), city: text(c?.name), district: text(d?.name) };
  };
  const emit = async (line: PlaceLine) => write(`${JSON.stringify(toOutput(compact(line), format))}\n`);
  let written = 0;

  for (const kind of kinds) {
    if (aborted()) break;
    if (kind === "office") {
      const cursor = Office.aggregate(officePipeline(since)).cursor({ batchSize: 200 });
      try {
        for await (const row of cursor) {
          if (aborted()) break;
          const point = coordsOf(row);
          const doctor = row.d || {};
          if (!point) continue;
          const doctorName = [text(doctor.firstName), text(doctor.lastName)].filter(Boolean).join(" ");
          const own = text(row.name);
          const speciality = await nameOf(Speciality as unknown as Model<any>, doctor.mainSpeciality);
          const hours = await officeHours(row._id);
          await emit({
            id: `noyanai:office:${row._id}`,
            type: kind,
            category: categorySlug[kind],
            category_name: text(speciality?.name),
            category_name_i18n: i18nOf(speciality, "name"),
            // the office's own name, else the doctor's (stored content is
            // Persian, SOURCE_LOCALE)
            name: own || (doctorName ? `دکتر ${doctorName}` : ""),
            // a named office has no translations (Office is not
            // translatable); otherwise the doctor's translated name
            name_i18n: own
              ? undefined
              : i18nOf(doctor, "name", (t) => [text(t.firstName), text(t.lastName)].filter(Boolean).join(" ")),
            doctor_name: doctorName,
            lat: point.lat,
            lng: point.lng,
            address: [text(row.address), text(row.addressDetail)].filter(Boolean).join("، "),
            ...(await geo(doctor)),
            phone: text(row.tel),
            website: website(doctor.website),
            url: `${base}${pagePath[kind]}${encodeURIComponent(doctor.slug)}`,
            hours: structuredHours(hours),
            opening_hours: osmOpeningHours(hours),
            ...(doctor._id ? await doctorReviews(doctor._id) : {}),
            updated_at: updatedOf(row, doctor),
          });
          written++;
        }
      } finally {
        await cursor.close().catch(() => undefined);
      }
      continue;
    }
    const cfg = centres[kind];
    const cursor = cfg.model.collection.find(centreMatch(kind, since), {
      projection: {
        name: 1,
        slug: 1,
        address: 1,
        phone: 1,
        location: 1,
        province: 1,
        city: 1,
        district: 1,
        category: 1,
        translations: 1,
        updatedAt: 1,
        ...(cfg.website ? { website: 1 } : {}),
        ...(cfg.hours ? { openingHours: 1 } : {}),
        ...(cfg.roundTheClock ? { [cfg.roundTheClock]: 1 } : {}),
      },
      batchSize: 200,
    });
    try {
      for await (const raw of cursor) {
        if (aborted()) break;
        const row = raw as Record<string, any>;
        const point = coordsOf(row);
        if (!point) continue;
        const category = cfg.categoryModel ? await nameOf(cfg.categoryModel, row.category) : null;
        const hours = cfg.hours ? osmOpeningHours(row.openingHours) : undefined;
        const roundTheClock = !!cfg.roundTheClock && row[cfg.roundTheClock] === true;
        await emit({
          id: `noyanai:${kind.toLowerCase()}:${row._id}`,
          type: kind,
          category: categorySlug[kind],
          category_name: text(category?.name),
          category_name_i18n: i18nOf(category, "name"),
          name: text(row.name),
          name_i18n: i18nOf(row, "name"),
          lat: point.lat,
          lng: point.lng,
          address: text(row.address),
          address_i18n: i18nOf(row, "address"),
          ...(await geo(row)),
          phone: text(row.phone),
          website: cfg.website ? website(row.website) : undefined,
          url: `${base}${pagePath[kind]}${encodeURIComponent(row.slug)}`,
          hours: cfg.hours ? structuredHours(row.openingHours) : undefined,
          opening_hours: hours || (roundTheClock ? "24/7" : undefined),
          ...(await centreReviews(cfg.model.modelName, row._id)),
          updated_at: updatedOf(row),
        });
        written++;
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }
  return written;
};
