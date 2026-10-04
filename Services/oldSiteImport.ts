import crypto from "crypto";
import mongoose, { Model } from "mongoose";
import AppError from "../Lib/AppError";
import slugify from "../Lib/slug";
import { isPhone } from "../Lib/validators";
import { cities } from "../Lib/Cities";
import { provinces } from "../Lib/Provinces";
import { getAppConfig } from "../Lib/appConfig";
import { createOldFiles, OldFiles, OldFilesStats } from "../Lib/oldFiles";
import { toSlateContent } from "../Lib/oldContent";
import { normalizePrescriptionStatus } from "../Lib/migrateDrugPrescriptionStatus";
import { legacyProfileFields, mergeLegacyDoctor } from "../Lib/mergeLegacyDoctors";
import OldDoctor from "../Models/Old/oldDoctor";
import OldUser from "../Models/Old/oldUser";
import OldSpeciality from "../Models/Old/oldSpeciality";
import OldBlog from "../Models/Old/OldBlog";
import OldDisease from "../Models/Old/OldDisease";
import OldDrug from "../Models/Old/OldDrug";
import OldPart from "../Models/Old/OldPart";
import OldSymptom from "../Models/Old/OldSymptom";
import Part, { PartRegion } from "../Models/Part";
import Speciality from "../Models/Speciality";
import Symptom from "../Models/Symptom";
import Drug from "../Models/Drug";
import Disease from "../Models/Disease";
import User from "../Models/User";
import Doctor from "../Models/Doctor";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorSocialMedia from "../Models/DoctorSocialMedia";
import GalleryItem from "../Models/GalleryItem";
import Redirection from "../Models/Redirection";
import Blog, { readMinutesOf } from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";

// Import of the old site's database (2026-10). The old site's dump is
// restored on this server as the database "Noyan" (deploy/arvan/
// import-old.sh); the Models/Old/* models read it. This copies it into the
// current models, in dependency order, as a background job with progress.
//
// Idempotent: every imported row is remembered in `legacy_import_state`
// (<kind>:<old _id> -> the record it became, and a hash of each field as it
// was written). A second run finds the same record (also through the `old`
// field earlier imports set, or by name/phone for a record made by hand on
// this site), so nothing is duplicated, and a field is refreshed from the
// old site only while nobody changed it here: an admin's edit wins.
// Bad rows (no name, invalid phone, broken references) are skipped and
// counted, never fatal.

export const OLD_IMPORT_STEPS = ["part", "speciality", "symptom", "drug", "disease", "user", "doctor", "blog"] as const;
export type OldImportStep = (typeof OLD_IMPORT_STEPS)[number];

// a step also runs what it links to, so its relations resolve
const STEP_DEPS: Record<OldImportStep, OldImportStep[]> = {
  part: [],
  speciality: [],
  symptom: ["part"],
  drug: [],
  disease: ["part", "speciality", "symptom", "drug"],
  user: [],
  doctor: ["speciality", "user"],
  blog: [],
};

export type ImportCounts = {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  messages: string[];
};

export type OldImportReport = {
  counts: Record<string, ImportCounts>;
  files: Omit<OldFilesStats, "failures"> & { failures: string[] };
  notes: string[];
};

export type OldImportOptions = {
  only?: OldImportStep[];
  filesBaseUrl?: string;
  downloadFiles?: boolean;
  source?: "panel" | "cli";
};

export type OldImportJob = {
  id: string;
  status: "running" | "done" | "failed";
  phase: string;
  total: number;
  processed: number;
  startedAt: string;
  finishedAt?: string;
  source: "panel" | "cli";
  steps: OldImportStep[];
  error?: { message: string };
  result?: OldImportReport;
};

const MAX_MESSAGES = 40;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_ID = "__lock";
const LAST_ID = "__lastReport";

const stateCol = () => mongoose.connection.collection("legacy_import_state");
const legacyUsersCol = () => mongoose.connection.collection("legacy_user_profiles");
const oldDbName = () => OldDoctor.db.name;
const oldCol = (model: Model<any>) =>
  mongoose.connection.getClient().db(oldDbName()).collection(model.collection.collectionName);

// ---------------------------------------------------------------- values

const ASCII_DIGITS: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (ASCII_DIGITS[d] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (ASCII_DIGITS[d] = String(i)));

const str = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const date = (v: unknown): Date | undefined => {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const oid = (v: unknown): mongoose.Types.ObjectId | undefined => {
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = typeof v === "string" ? v : (v as { _id?: unknown; toHexString?: () => string })?.toHexString?.();
  return s && /^[0-9a-f]{24}$/i.test(s) ? new mongoose.Types.ObjectId(s) : undefined;
};
const oids = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(oid).filter(Boolean) as mongoose.Types.ObjectId[];
const mapRefs = (v: unknown, map: Map<string, mongoose.Types.ObjectId>) => {
  const out: mongoose.Types.ObjectId[] = [];
  for (const id of oids(v)) {
    const to = map.get(String(id));
    if (to && !out.some((o) => o.equals(to))) out.push(to);
  }
  return out;
};

export const normalizeOldPhone = (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  let s = String(v).replace(/[۰-۹٠-٩]/g, (d) => ASCII_DIGITS[d]).replace(/\D/g, "");
  if (s.startsWith("0098")) s = s.slice(2);
  if (/^9\d{9}$/.test(s)) s = `98${s}`;
  return isPhone(s);
};

const genderOf = (v: unknown) => {
  const s = str(v)?.toLowerCase();
  if (!s) return undefined;
  if (/^(male|man|m|مرد|آقا|مردان|آقایان)$/.test(s)) return "male";
  if (/^(female|woman|f|زن|خانم|زنان|بانوان)$/.test(s)) return "female";
  if (/^(none|both|all|هر دو|همه|ندارد)$/.test(s)) return "none";
  return undefined;
};

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const hashOf = (v: unknown) =>
  empty(v) ? "" : crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const uniqueSlug = async (model: Model<any>, base: string, fallback: string) => {
  const root = slugify(base) || fallback;
  let slug = root;
  let n = 2;
  while (await model.exists({ slug })) slug = `${root}-${n++}`;
  return slug;
};

// ---------------------------------------------------------------- sync

type SyncInput = {
  model: Model<any>;
  kind: string;
  oldId: mongoose.Types.ObjectId;
  fields: Record<string, unknown>;
  // an existing record for this old row that was not made by this import
  // (an earlier import's `old` link, or the same name made by hand)
  findExisting?: () => Promise<any | null>;
  // set on a found record (e.g. its `old` link)
  link?: Record<string, unknown>;
  create: (fields: Record<string, unknown>) => Promise<mongoose.Types.ObjectId>;
  extraState?: Record<string, unknown>;
};
type SyncResult = { id: mongoose.Types.ObjectId; outcome: "created" | "updated" | "unchanged" };

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const sync = async ({ model, kind, oldId, fields, findExisting, link, create, extraState }: SyncInput): Promise<SyncResult> => {
  const stateId = `${kind}:${oldId}`;
  const state = (await stateCol().findOne({ _id: stateId as never })) as any;
  let target: any = state?.target ? await model.collection.findOne({ _id: state.target }) : null;
  let outcome: SyncResult["outcome"] = "unchanged";
  let id: mongoose.Types.ObjectId;
  // fields whose snapshot is renewed: the ones this run wrote or found equal.
  // A field kept because it was edited here keeps its old snapshot, so the
  // edit stays protected on every later run.
  let snapKeys = Object.keys(fields);
  if (!target && findExisting) target = await findExisting();
  if (!target) {
    id = await create(defined(fields));
    outcome = "created";
  } else {
    id = target._id;
    const snap: Record<string, string> = (state && String(state.target) === String(id) && state.snap) || {};
    const $set: Record<string, unknown> = {};
    snapKeys = [];
    for (const [k, next] of Object.entries(fields)) {
      const cur = hashOf(target[k]);
      const prev = snap[k];
      const nextHash = hashOf(next);
      if (nextHash === cur) {
        snapKeys.push(k);
        continue;
      }
      // a value the old site no longer has is kept here, never erased
      if (empty(next)) continue;
      // first time this record meets this old row: only fill what is empty
      const untouched = prev === undefined ? cur === "" : prev === cur;
      if (!untouched) continue;
      $set[k] = next;
      snapKeys.push(k);
    }
    if (link) for (const [k, v] of Object.entries(link)) if (hashOf(target[k]) !== hashOf(v)) $set[k] = v;
    if (Object.keys($set).length) {
      await model.updateOne({ _id: id }, { $set });
      outcome = "updated";
    }
  }
  const stored: any = (await model.collection.findOne({ _id: id })) || {};
  const snapSet: Record<string, unknown> = {};
  for (const k of snapKeys) snapSet[`snap.${k}`] = hashOf(stored[k]);
  await stateCol().updateOne(
    { _id: stateId as never },
    {
      $set: { target: id, model: model.modelName, at: new Date(), ...snapSet, ...(extraState || {}) },
    },
    { upsert: true },
  );
  return { id, outcome };
};

const stateMap = async (kind: string) => {
  const map = new Map<string, mongoose.Types.ObjectId>();
  const rows = await stateCol()
    .find({ _id: { $regex: `^${kind}:` } as never }, { projection: { target: 1 } })
    .toArray();
  for (const r of rows as any[]) if (r.target) map.set(String(r._id).slice(kind.length + 1), r.target);
  return map;
};

// ---------------------------------------------------------------- runner

type Ctx = {
  files: OldFiles;
  counts: Record<string, ImportCounts>;
  notes: string[];
  tick: (phase?: string) => Promise<void>;
};

const newCounts = (): ImportCounts => ({ total: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, messages: [] });
const countsOf = (ctx: Ctx, key: string) => (ctx.counts[key] ||= newCounts());
const note = (c: ImportCounts, msg: string) => {
  if (c.messages.length < MAX_MESSAGES) c.messages.push(msg);
};

// one pass over an old collection; fn returns the outcome, "skipped:<why>"
const eachOld = async (
  ctx: Ctx,
  key: string,
  model: Model<any>,
  fn: (row: any) => Promise<SyncResult["outcome"] | `skipped:${string}`>,
  { count = true }: { count?: boolean } = {},
) => {
  const c = countsOf(ctx, key);
  const cursor = oldCol(model).find({}).batchSize(200);
  for await (const row of cursor) {
    if (count) c.total++;
    try {
      const outcome = await fn(row);
      if (count) {
        if (outcome.startsWith("skipped:")) {
          c.skipped++;
          note(c, `${row._id}: ${outcome.slice(8)}`);
        } else c[outcome as "created" | "updated" | "unchanged"]++;
      }
    } catch (err) {
      c.errors++;
      note(c, `${row?._id}: ${(err as Error)?.message || String(err)}`.slice(0, 300));
      console.error(`[oldImport] ${key} ${row?._id}`, (err as Error)?.message);
    }
    if (count) await ctx.tick();
  }
};

const nameMatch = (model: Model<any>, field: string, value?: string) => async () =>
  value ? model.collection.findOne({ [field]: value, old: null }) : null;

// ---------------------------------------------------------------- steps

// where an old body part sits on the symptom map (Models/Part.ts); unknown
// names stay without a region for the admin to set
const PART_REGIONS: [PartRegion, string[]][] = [
  ["neck", ["گردن", "حلق", "گلو", "تیروئید"]],
  ["head", ["سر", "صورت", "چشم", "گوش", "بینی", "دهان", "دندان", "مغز", "زبان", "لب", "اعصاب"]],
  ["chest", ["سینه", "قلب", "ریه", "پستان", "تنفسی"]],
  ["abdomen", ["شکم", "معده", "روده", "کبد", "کلیه", "گوارش", "گوارشی"]],
  ["pelvis", ["لگن", "مثانه", "تناسلی", "رحم", "پروستات", "باسن"]],
  ["back", ["کمر", "پشت"]],
  ["arms", ["دست", "بازو", "آرنج", "انگشت", "شانه"]],
  ["legs", ["پا", "ران", "زانو", "ساق"]],
  ["skin", ["پوست", "مو", "ناخن"]],
  ["general", ["عمومی"]],
];
// by whole words ("پا" is not "پانکراس"), plural "ها" allowed
const regionOf = (name: string) => {
  const words = name.replace(/ي/g, "ی").replace(/ك/g, "ک").split(/[\s‌،,\-–()/]+/).filter(Boolean);
  const has = (t: string) => words.some((w) => w === t || w === `${t}ها`);
  return PART_REGIONS.find(([, tokens]) => tokens.some(has))?.[0];
};

const importParts = (ctx: Ctx) =>
  eachOld(ctx, "part", OldPart, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const r = await sync({
      model: Part,
      kind: "part",
      oldId: row._id,
      fields: { name, order: num(row.order) ?? 0 },
      findExisting: async () => (await Part.collection.findOne({ old: row._id })) || nameMatch(Part, "name", name)(),
      link: { old: row._id },
      create: async (f) =>
        (
          await Part.create({
            ...f,
            slug: await uniqueSlug(Part, name, String(row._id)),
            isActive: true,
            ...(regionOf(name) && { region: regionOf(name) }),
            old: row._id,
          })
        )._id,
    });
    return r.outcome;
  });

const importSpecialities = (ctx: Ctx) =>
  eachOld(ctx, "speciality", OldSpeciality, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const r = await sync({
      model: Speciality,
      kind: "speciality",
      oldId: row._id,
      fields: {
        name,
        image: await ctx.files.resolve(row.image),
        order: num(row.order) ?? 0,
        summary: str(row.summary),
        isHome: !!row.featured,
      },
      findExisting: async () =>
        (await Speciality.collection.findOne({ old: row._id })) || nameMatch(Speciality, "name", name)(),
      link: { old: row._id },
      create: async (f) =>
        (await Speciality.create({ ...f, slug: await uniqueSlug(Speciality, name, String(row._id)), active: true, old: row._id }))._id,
    });
    return r.outcome;
  });

const medicalCreate = (model: Model<any>, name: string, oldId: mongoose.Types.ObjectId) => async (f: Record<string, unknown>) =>
  (await model.create({ ...f, slug: await uniqueSlug(model, name, String(oldId)), published: true, old: oldId }))._id;

const importSymptoms = async (ctx: Ctx) => {
  const parts = await stateMap("part");
  await eachOld(ctx, "symptom", OldSymptom, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const r = await sync({
      model: Symptom,
      kind: "symptom",
      oldId: row._id,
      fields: {
        name,
        genderSpecific: genderOf(row.genderSpecific),
        part: mapRefs(row.part, parts),
        summary: str(row.summary),
        description: str(row.description),
        expectedPrognosis: str(row.expectedPrognosis),
        image: await ctx.files.resolve(row.image),
        naturalProgression: str(row.naturalProgression),
        pathophysiology: str(row.pathophysiology),
        possibleComplication: str(row.possibleComplication),
        order: num(row.order) ?? 0,
      },
      findExisting: async () => (await Symptom.collection.findOne({ old: row._id })) || nameMatch(Symptom, "name", name)(),
      link: { old: row._id },
      create: medicalCreate(Symptom, name, row._id),
    });
    return r.outcome;
  });
  // sameAs points at other symptoms: once all of them exist
  const symptoms = await stateMap("symptom");
  await eachOld(
    ctx,
    "symptom",
    OldSymptom,
    async (row) => {
      if (!symptoms.has(String(row._id)) || !oids(row.sameAs).length) return "unchanged";
      return (await sync(relationSync(Symptom, "symptom", row._id, { sameAs: mapRefs(row.sameAs, symptoms) }))).outcome;
    },
    { count: false },
  );
};

const relationSync = (model: Model<any>, kind: string, oldId: mongoose.Types.ObjectId, fields: Record<string, unknown>): SyncInput => ({
  model,
  kind,
  oldId,
  fields,
  create: async () => {
    throw new Error("record missing");
  },
});

const importDrugs = (ctx: Ctx) =>
  eachOld(ctx, "drug", OldDrug, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const text = (k: string) => str(row[k]);
    const r = await sync({
      model: Drug,
      kind: "drug",
      oldId: row._id,
      fields: {
        name,
        summary: text("summary"),
        description: text("description"),
        sideEffects: text("sideEffects"),
        activeIngridient: text("activeIngridient"),
        adminstrationRoute: text("adminstrationRoute"),
        alcoholWarning: text("alcoholWarning"),
        alternateName: text("alternateName"),
        breastfeedingWarning: text("breastfeedingWarning"),
        clinicalPharmacology: text("clinicalPharmacology"),
        dosageForm: text("dosageForm"),
        drugUnit: text("drugUnit"),
        foodWarning: text("foodWarning"),
        identifier: text("identifier"),
        image: await ctx.files.resolve(row.image),
        overdosage: text("overdosage"),
        pregnancyWarning: text("pregnancyWarning"),
        prescribingInfo: text("prescribingInfo"),
        prescriptionStatus: normalizePrescriptionStatus(row.prescriptionStatus),
        warning: text("warning"),
        order: num(row.order) ?? 0,
      },
      findExisting: async () => (await Drug.collection.findOne({ old: row._id })) || nameMatch(Drug, "name", name)(),
      link: { old: row._id },
      create: medicalCreate(Drug, name, row._id),
    });
    // the old free text stays next to the enum (as Lib/migrateDrugPrescriptionStatus does)
    const legacyText = str(row.prescriptionStatus);
    if (legacyText) await Drug.collection.updateOne({ _id: r.id }, { $set: { prescriptionStatusLegacy: legacyText } });
    return r.outcome;
  });

const importDiseases = async (ctx: Ctx) => {
  const [symptoms, specialities, drugs] = await Promise.all([stateMap("symptom"), stateMap("speciality"), stateMap("drug")]);
  await eachOld(ctx, "disease", OldDisease, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const r = await sync({
      model: Disease,
      kind: "disease",
      oldId: row._id,
      fields: {
        name,
        description: str(row.description),
        summary: str(row.summary),
        symptoms: mapRefs(row.symptoms, symptoms),
        specialities: mapRefs(row.specialities, specialities),
        drugs: mapRefs(row.drugs, drugs),
        genderSpecific: genderOf(row.genderSpecific),
        expectedPrognosis: str(row.expectedPrognosis),
        image: await ctx.files.resolve(row.image),
        naturalProgression: str(row.naturalProgression),
        pathophysiology: str(row.pathophysiology),
        // the old field name was misspelled
        possibleComplication: str(row.possibleComlplication) ?? str(row.possibleComplication),
        order: num(row.order) ?? 0,
      },
      findExisting: async () => (await Disease.collection.findOne({ old: row._id })) || nameMatch(Disease, "name", name)(),
      link: { old: row._id },
      create: medicalCreate(Disease, name, row._id),
    });
    return r.outcome;
  });
  const diseases = await stateMap("disease");
  await eachOld(
    ctx,
    "disease",
    OldDisease,
    async (row) => {
      if (!diseases.has(String(row._id)) || !oids(row.sameAs).length) return "unchanged";
      return (await sync(relationSync(Disease, "disease", row._id, { sameAs: mapRefs(row.sameAs, diseases) }))).outcome;
    },
    { count: false },
  );
};

// Accounts: the phone is the identity (login is by SMS code), so an old
// account and one already made here with the same number are one user.
// Nothing secret is copied (the old schema holds none; OTP/passwords of any
// kind are never read), and no role: an old "admin" is a plain user here -
// admins are set by the super admin. The old profile details that have no
// field on User are kept aside in legacy_user_profiles.
const importUsers = async (ctx: Ctx) => {
  const seen = new Map<string, string>();
  await eachOld(ctx, "user", OldUser, async (row) => {
    const phone = normalizeOldPhone(row.phone);
    if (!phone) return "skipped:invalid phone";
    const username =
      str(row.name) || [str(row.firstName), str(row.lastName)].filter(Boolean).join(" ") || undefined;
    const existing: any = await User.collection.findOne({ phone });
    const first = existing ? seen.get(String(existing._id)) : undefined;
    const duplicate = !!first && first !== String(row._id);
    const r = await sync({
      model: User,
      kind: "user",
      oldId: row._id,
      // a second old account with the same number only maps to the first one
      fields: duplicate ? {} : { username, avatar: await ctx.files.resolve(row.image) },
      findExisting: async () => existing,
      create: async (f) => (await User.create({ ...f, phone }))._id,
    });
    await legacyUsersCol().updateOne(
      { _id: r.id as never },
      {
        // a second old account with the same number adds only its id
        $set: duplicate ? { at: new Date() } : defined({
          name: str(row.name),
          firstName: str(row.firstName),
          lastName: str(row.lastName),
          gender: str(row.gender),
          birthYear: num(row.birth),
          birthDate: date(row.exactBirth),
          oldRole: str(row.role),
          license: str(row.license),
          licenseExpiration: date(row.licenseExpiration),
          balance: num(row.balance),
          at: new Date(),
        }),
        $addToSet: { oldIds: row._id },
      },
      { upsert: true },
    );
    if (duplicate) return `skipped:same phone as ${first}`;
    if (!seen.has(String(r.id))) seen.set(String(r.id), String(row._id));
    return r.outcome;
  });
};

const SOCIAL: [string, "Instagram" | "Telegarm" | "Aparat"][] = [
  ["instagram", "Instagram"],
  ["telegram", "Telegarm"],
  ["aparat", "Aparat"],
];

// Old directory doctors -> the legacy Doctor record (kept: it holds every
// old field and the 301 from its old URL) -> the bookable DoctorProfile
// (claimed: false, Lib/mergeLegacyDoctors.ts). A profile the doctor has
// claimed is theirs and is not touched again.
const importDoctors = async (ctx: Ctx) => {
  const specialities = await stateMap("speciality");
  const users = await stateMap("user");
  const profiles = countsOf(ctx, "doctorProfile");
  let linkedAccounts = 0;
  await eachOld(ctx, "doctor", OldDoctor, async (row) => {
    const name = str(row.name);
    if (!name) return "skipped:no name";
    const lat = num(row.lat);
    const lng = num(row.lng);
    const geoOk = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    const main = mapRefs(row.speciality, specialities)[0];
    const images: string[] = [];
    for (const img of Array.isArray(row.images) ? row.images : []) {
      const f = await ctx.files.resolve(img);
      if (f && !images.includes(f)) images.push(f);
    }
    const oldUser = oid(row.user);
    const account = oldUser ? users.get(String(oldUser)) : undefined;
    const r = await sync({
      model: Doctor,
      kind: "doctor",
      oldId: row._id,
      fields: {
        name,
        image: await ctx.files.resolve(row.image),
        code: str(row.code),
        hours: str(row.hours),
        awards: str(row.awards),
        birthDate: date(row.birthDate),
        description: str(row.description),
        summary: str(row.summary),
        images,
        order: num(row.order) ?? 0,
        active: row.active !== false,
        address: str(row.address),
        landLine: str(row.landLine),
        mobile: str(row.mobile),
        lat: geoOk ? String(lat) : undefined,
        lng: geoOk ? String(lng) : undefined,
        email: str(row.email),
        province: provinces.find((p) => p.name === str(row.province) || p.slug === str(row.province))?.slug,
        city: cities.find((c) => c.name === str(row.newCity) || c.slug === str(row.newCity))?.slug,
        site: str(row.link),
        telegram: str(row.telegram),
        twitter: str(row.twitter),
        youtube: str(row.youtube),
        aparat: str(row.aparat),
        linkedin: str(row.linkedin),
        instagram: str(row.instagram),
        speciality: main,
        specialities: [main, ...mapRefs(row.specialities, specialities)].filter(
          (id, i, all): id is mongoose.Types.ObjectId => !!id && all.findIndex((o) => o && o.equals(id)) === i,
        ),
      },
      findExisting: () => Doctor.collection.findOne({ old: row._id }),
      link: { old: row._id },
      create: async (f) =>
        (await Doctor.create({ ...f, slug: await uniqueSlug(Doctor, name.replace(/^\s*(دکتر|Dr\.?)\s+/i, ""), String(row._id)), old: row._id }))._id,
      // the old account of this doctor: recorded, not applied - owning a
      // profile goes through the claim flow (identity check)
      extraState: account ? { oldAccount: account } : {},
    });
    if (account) linkedAccounts++;

    // the bookable profile
    const legacy: any = await Doctor.collection.findOne({ _id: r.id });
    let existing: any = await DoctorProfile.collection.findOne({ legacyDoctor: r.id });
    if (!existing) {
      // the legacy Doctor was deleted and imported again (devtools "drop"):
      // its profile is still the same doctor's
      const st: any = await stateCol().findOne({ _id: `doctorprofile:${row._id}` as never });
      existing = st?.target ? await DoctorProfile.collection.findOne({ _id: st.target }) : null;
      if (existing) {
        await DoctorProfile.collection.updateOne({ _id: existing._id }, { $set: { legacyDoctor: r.id } });
        await Doctor.collection.updateOne({ _id: r.id }, { $set: { mergedInto: existing._id } });
        legacy.mergedInto = existing._id;
      }
    }
    profiles.total++;
    let profileId: mongoose.Types.ObjectId;
    try {
      if (!existing) {
        const p = await mergeLegacyDoctor(legacy);
        profileId = p._id;
        await sync({
          model: DoctorProfile,
          kind: "doctorprofile",
          oldId: row._id,
          fields: await legacyProfileFields(legacy),
          create: async () => p._id,
          findExisting: async () => DoctorProfile.collection.findOne({ _id: p._id }),
        });
        profiles.created++;
      } else {
        profileId = existing._id;
        if (!legacy.mergedInto) await mergeLegacyDoctor(legacy);
        if (existing.claimed !== false) profiles.unchanged++;
        else {
          const pr = await sync({
            model: DoctorProfile,
            kind: "doctorprofile",
            oldId: row._id,
            fields: await legacyProfileFields(legacy),
            findExisting: async () => existing,
            create: async () => existing._id,
          });
          profiles[pr.outcome]++;
        }
      }
      // the old site had no doctor slugs: its links carried the old id
      const prof: any = await DoctorProfile.collection.findOne({ _id: profileId }, { projection: { slug: 1 } });
      await Redirection.updateOne(
        { old: `/doctor/${row._id}` },
        { $set: { current: `/dr/${prof?.slug || profileId}`, statusCode: 301 } },
        { upsert: true },
      );
      const claimed = existing && existing.claimed !== false;
      if (!claimed) {
        for (const [field, media] of SOCIAL) {
          const target = str(row[field]);
          if (target && !(await DoctorSocialMedia.exists({ doctor: profileId, media })))
            await DoctorSocialMedia.create({ doctor: profileId, media, target });
        }
        // only pictures that are really here: a gallery of broken images is worse than none
        const gallery = images.filter(ctx.files.available);
        for (let i = 0; i < gallery.length; i++)
          await GalleryItem.updateOne(
            { owner: profileId, ownerPath: "DoctorProfile", image: gallery[i] },
            { $setOnInsert: { alt: name, active: true, order: i, createdAt: new Date() } },
            { upsert: true },
          );
      }
    } catch (err) {
      profiles.errors++;
      note(profiles, `${row._id}: ${(err as Error).message}`.slice(0, 300));
    }
    return r.outcome;
  });
  if (linkedAccounts)
    ctx.notes.push(
      `${linkedAccounts} old doctor(s) had an account on the old site; the link is recorded in legacy_import_state (oldAccount) and not applied: the doctor claims the profile.`,
    );
};

const blogStatus = (v: unknown) => (v === "Publish" ? "Publish" : v === "Pending" ? "Pending" : "Draft");

const importBlogs = async (ctx: Ctx) => {
  const doctorProfiles = await stateMap("doctorprofile");
  const categories = countsOf(ctx, "blogCategory");
  const categoryIds = new Map<string, mongoose.Types.ObjectId>();
  const categoryOf = async (raw: unknown) => {
    const title = str(raw);
    if (!title) return undefined;
    if (categoryIds.has(title)) return categoryIds.get(title);
    let found: any = await BlogCategory.collection.findOne({ title });
    if (!found) {
      found = await BlogCategory.create({ title, slug: await uniqueSlug(BlogCategory, title, `category-${Date.now()}`) });
      categories.created++;
    } else categories.unchanged++;
    categories.total++;
    categoryIds.set(title, found._id);
    return found._id as mongoose.Types.ObjectId;
  };
  await eachOld(ctx, "blog", OldBlog, async (row) => {
    const title = str(row.name);
    if (!title) return "skipped:no title";
    const status = blogStatus(row.status);
    const owner = oid(row.owner);
    const profile = owner ? doctorProfiles.get(String(owner)) : undefined;
    const ownerDoc: any = profile ? await DoctorProfile.collection.findOne({ _id: profile }, { projection: { firstName: 1, lastName: 1 } }) : null;
    const content = await toSlateContent(str(row.mainContent) || str(row.content), ctx.files);
    const r = await sync({
      model: Blog,
      kind: "blog",
      oldId: row._id,
      fields: {
        title,
        summary: str(row.summary),
        image: await ctx.files.resolve(row.image),
        content,
        // what Blog's own save hook computes (updateOne skips it)
        readMinutes: readMinutesOf(content),
        // no date on the old row: when it was created (its id's timestamp)
        publishedAt: date(row.publishedAt) || date(row.submittedAt) || oid(row._id)?.getTimestamp(),
        published: status === "Publish",
        chosen: !!row.featured,
        category: await categoryOf(row.category),
        ...(profile
          ? {
              authorType: "doctor",
              authorOrg: profile,
              author: [ownerDoc?.firstName, ownerDoc?.lastName].filter(Boolean).join(" ") || undefined,
              reviewStatus: status === "Publish" ? "approved" : status === "Pending" ? "pending" : undefined,
            }
          : {}),
      },
      findExisting: () => Blog.collection.findOne({ old: row._id }),
      link: { old: row._id },
      create: async (f) => {
        // keep the old address when it is a valid, free slug
        const oldSlug = str(row.slug);
        const slug = oldSlug && slugify(oldSlug) === oldSlug && !(await Blog.exists({ slug: oldSlug })) ? oldSlug : await uniqueSlug(Blog, oldSlug || title, String(row._id));
        return (await Blog.create({ ...f, slug, old: row._id }))._id;
      },
    });
    return r.outcome;
  });
  const blogs = await stateMap("blog");
  await eachOld(
    ctx,
    "blog",
    OldBlog,
    async (row) => {
      if (!blogs.has(String(row._id)) || !oids(row.related).length) return "unchanged";
      return (await sync(relationSync(Blog, "blog", row._id, { related: mapRefs(row.related, blogs) }))).outcome;
    },
    { count: false },
  );
};

const STEP_RUN: Record<OldImportStep, (ctx: Ctx) => Promise<void>> = {
  part: importParts,
  speciality: importSpecialities,
  symptom: importSymptoms,
  drug: importDrugs,
  disease: importDiseases,
  user: importUsers,
  doctor: importDoctors,
  blog: importBlogs,
};

const STEP_MODEL: Record<OldImportStep, Model<any>> = {
  part: OldPart,
  speciality: OldSpeciality,
  symptom: OldSymptom,
  drug: OldDrug,
  disease: OldDisease,
  user: OldUser,
  doctor: OldDoctor,
  blog: OldBlog,
};

export const resolveSteps = (only?: OldImportStep[]) => {
  if (!only?.length) return [...OLD_IMPORT_STEPS];
  const wanted = new Set<OldImportStep>();
  const add = (s: OldImportStep) => {
    STEP_DEPS[s].forEach(add);
    wanted.add(s);
  };
  only.forEach(add);
  return OLD_IMPORT_STEPS.filter((s) => wanted.has(s));
};

// ---------------------------------------------------------------- lock

const acquireLock = async (owner: string) => {
  const now = new Date();
  try {
    await stateCol().insertOne({ _id: LOCK_ID as never, owner, at: now });
    return;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  const taken = await stateCol().findOneAndUpdate(
    { _id: LOCK_ID as never, at: { $lt: new Date(now.getTime() - LOCK_STALE_MS) } },
    { $set: { owner, at: now } },
  );
  if (!taken) throw new AppError("انتقال داده‌های سایت قدیم همین حالا در حال اجراست", 409);
};
const touchLock = (owner: string) => stateCol().updateOne({ _id: LOCK_ID as never, owner }, { $set: { at: new Date() } });
const releaseLock = (owner: string) => stateCol().deleteOne({ _id: LOCK_ID as never, owner });

// ---------------------------------------------------------------- entry

const countOld = async (steps: OldImportStep[]) => {
  const totals = await Promise.all(steps.map((s) => oldCol(STEP_MODEL[s]).countDocuments()));
  const total = totals.reduce((a, b) => a + b, 0);
  if (!total) throw new AppError("دیتابیس سایت قدیم روی این سرور خالی است", 400);
  return total;
};

// what an admin hears right away instead of from a failed job
export const assertOldImportCanStart = async (options: OldImportOptions) => {
  await countOld(resolveSteps(options.only));
  const lock: any = await stateCol().findOne({ _id: LOCK_ID as never });
  if (lock && Date.now() - new Date(lock.at).getTime() < LOCK_STALE_MS)
    throw new AppError("انتقال داده‌های سایت قدیم همین حالا در حال اجراست", 409);
};

export const runOldImport = async (
  options: OldImportOptions,
  progress?: (p: { phase: string; processed: number; total: number }) => void,
): Promise<OldImportReport> => {
  const steps = resolveSteps(options.only);
  const total = await countOld(steps);

  const owner = crypto.randomUUID();
  await acquireLock(owner);
  try {
    const config = await getAppConfig().catch(() => null);
    const ownOrigins = [process.env.FILE_PATH, config?.siteBaseUrl ? `${config.siteBaseUrl.replace(/\/+$/, "")}/files` : undefined].filter(
      Boolean,
    ) as string[];
    const files = createOldFiles({
      baseUrl: options.filesBaseUrl || process.env.OLD_FILES_BASE_URL || undefined,
      download: options.downloadFiles !== false,
      ownOrigins,
    });
    let processed = 0;
    let phase = "starting";
    let lastTouch = Date.now();
    const ctx: Ctx = {
      files,
      counts: {},
      notes: [],
      tick: async (next?: string) => {
        if (next) phase = next;
        else processed++;
        progress?.({ phase, processed, total });
        if (Date.now() - lastTouch > 60_000) {
          lastTouch = Date.now();
          await touchLock(owner);
        }
      },
    };
    for (const step of steps) {
      await ctx.tick(step);
      countsOf(ctx, step);
      await STEP_RUN[step](ctx);
    }
    if (!files.stats.downloaded && !files.stats.failed && files.stats.kept && !options.filesBaseUrl && !process.env.OLD_FILES_BASE_URL)
      ctx.notes.push(
        `${files.stats.kept} file path(s) were kept without a copy: set OLD_FILES_BASE_URL (or copy the old upload folder into Public/) and run the import again.`,
      );
    return { counts: ctx.counts, files: { ...files.stats }, notes: ctx.notes };
  } finally {
    await releaseLock(owner).catch(() => {});
  }
};

const saveLast = (job: OldImportJob) =>
  stateCol()
    .updateOne({ _id: LAST_ID as never }, { $set: { job: { ...job } } }, { upsert: true })
    .catch(() => {});

let current: OldImportJob | null = null;

// the import as a background job of this process (the admin panel polls it)
export const startOldImportJob = async (options: OldImportOptions): Promise<OldImportJob> => {
  if (current?.status === "running") return current;
  await assertOldImportCanStart(options);
  const steps = resolveSteps(options.only);
  const job: OldImportJob = {
    id: crypto.randomUUID(),
    status: "running",
    phase: "starting",
    total: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    source: options.source || "panel",
    steps,
  };
  current = job;
  setImmediate(() => {
    runOldImport(options, (p) => {
      job.phase = p.phase;
      job.processed = p.processed;
      job.total = p.total;
    })
      .then((result) => {
        job.result = result;
        job.status = "done";
        job.phase = "done";
      })
      .catch((err: unknown) => {
        console.error("[oldImport] failed", err);
        job.status = "failed";
        job.phase = "failed";
        job.error = { message: (err as Error)?.message || String(err) };
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        saveLast(job);
      });
  });
  return job;
};

// the running job, else the last finished run (also one run from the
// command line, Scripts/importOld.ts)
export const getOldImportJob = async (): Promise<OldImportJob | null> => {
  if (current?.status === "running") return current;
  const last = (await stateCol().findOne({ _id: LAST_ID as never })) as { job?: OldImportJob } | null;
  if (current && (!last?.job || last.job.startedAt <= current.startedAt)) return current;
  return last?.job || current;
};

// devtools drop/purge: the import forgets these rows, so a later run
// creates (drop) or leaves alone (purge) them instead of updating
export const forgetImported = (kind: OldImportStep) =>
  stateCol().deleteMany({ _id: { $regex: `^${kind}:` } as never });

export const recordCliRun = (job: OldImportJob) => saveLast(job);
