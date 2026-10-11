import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import net from "net";
import path from "path";
import mongoose, { Model, Types } from "mongoose";
import AppError from "../Lib/AppError";
import slugify from "../Lib/slug";
import { NODE_ENV } from "../Lib/Env";
import { getBookingHorizonDays } from "../Lib/appConfig";
import { matchDivision } from "../Lib/geoFromPoint";
import { normalizeOpeningHours } from "../Lib/openingHours";
import { withCentreLicenceWrite } from "../Lib/centreLicenceLock";
import { normalizeWebsite } from "../Lib/contactLinks";
import { clearDirectoryCache } from "../Lib/directoryCache";
import { clearSeoCache } from "../Lib/seo/seoCache";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { applyOrder, AnyKind, IMPORT_MAX_RECORDS, ImportKind, ImportVisitType, kindFields } from "../Lib/providerImport/catalog";
import { analyseFile, applyRule, isEmptyValue, ListMapping, mapRecord, Mapping, mappingSchema, valueKey } from "../Lib/providerImport/mapping";
import { recordsAt } from "../Lib/providerImport/source";
import { allIssues, CleanRecord, cleanRecord, Issue, ISSUE } from "../Lib/providerImport/native";
import { sniffExtension } from "../Controllers/uploadController";
import ProviderImport, { IProviderImport } from "../Models/ProviderImport";
import ProviderImportLink from "../Models/ProviderImportLink";
import AdminAuditLog from "../Models/AdminAuditLog";
import DoctorProfile from "../Models/DoctorProfile";
import { medicalSystemTitles } from "../Models/BecomeDoctorRequest";
import Office from "../Models/Office";
import DoctorShift from "../Models/DoctorShift";
import InPersonSettings from "../Models/InPersonSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import DoctorInsurance from "../Models/DoctorInsurance";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import Speciality from "../Models/Speciality";
import ServiceCategory from "../Models/ServiceCategory";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import ClinicCategory from "../Models/ClinicCategory";
import HospitalCategory from "../Models/HospitalCategory";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import InsuranceCategory from "../Models/InsuranceCategory";
import Test from "../Models/Test";
import ParaClinicTest from "../Models/ParaClinicTest";

// Bulk provider import (2026-10, the owner's request before the move to
// noyanai.com): the super admin loads many doctors, offices, clinics,
// hospitals, labs, pharmacies and insurers from one JSON file.
//
// Flow: upload (the file is kept server-side, NotPublic/imports/<id>.json)
// -> the panel maps the source's fields to ours (Lib/providerImport/
// mapping.ts; our documented format maps 1:1) with a live preview ->
// dry run (validate: every check, every lookup, nothing written) -> run
// (a background job with progress) -> report. The file is deleted when the
// run is over.
//
// Rules:
//  - idempotent: a record is found again by its source id (externalId,
//    Models/ProviderImportLink.ts), then by the council number (doctors),
//    then by slug - a second run updates, never duplicates;
//  - one bad record never stops the others (each is written on its own and
//    reported with its path and the reason);
//  - imported pages are public but unclaimed: no account, no phone login,
//    no SMS. The doctor claims the page through the onboarding (council
//    inquiry + SMS OTP, Controllers/doctorOnboardingController.ts); a
//    centre through its become-request approval (link the existing centre);
//  - a page someone already owns (claimed) is never overwritten: the import
//    only fills its empty fields;
//  - every write goes through the models' own save paths, so the map pin
//    fills province / city / district (Lib/geoFromPoint.ts), opening hours
//    derive their "open now" intervals, the doctor's location follows the
//    office, and availability is rebuilt from the new weekly hours;
//  - texts are stored in Persian (the source language) with any
//    translations the file gives; the rest is picked up by the existing
//    machine translation (Translations page -> translate missing).

const IMPORT_DIR = path.join(process.cwd(), "NotPublic", "imports");
const PUBLIC_DIR = path.join(process.cwd(), "Public");
const KEEP_UNUSED_FILE_MS = 24 * 3600 * 1000;
const PREVIEW_RECORDS = 5;
const MAX_REPORT_RECORDS = 20_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;

export const IMPORT_RUNNING_ERROR = "یک ورود گروهی دیگر در حال اجراست؛ پس از پایان آن دوباره امتحان کنید";
export const IMPORT_BAD_JSON_ERROR = "فایل JSON معتبر نیست";
export const IMPORT_NO_LISTS_ERROR = "در این فایل هیچ فهرستی از رکوردها پیدا نشد";
export const IMPORT_FILE_GONE_ERROR = "فایل این ورود گروهی دیگر روی سرور نیست؛ آن را دوباره بارگذاری کنید";
export const IMPORT_BAD_MAPPING_ERROR = "نگاشت فیلدها معتبر نیست";
export const IMPORT_TOO_MANY_ERROR = "تعداد رکوردهای فایل بیش از حد مجاز است";

// ------------------------------------------------------------ files

const fileOf = (id: unknown) => path.join(IMPORT_DIR, `${String(id)}.json`);
const rootCache = new Map<string, { at: number; root: unknown }>();

const cacheRoot = (id: string, root: unknown) => {
  rootCache.set(id, { at: Date.now(), root });
  while (rootCache.size > 3) {
    const oldest = [...rootCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    rootCache.delete(oldest[0]);
  }
};

export const loadRoot = async (id: string): Promise<unknown> => {
  const hit = rootCache.get(id);
  if (hit) {
    hit.at = Date.now();
    return hit.root;
  }
  let text: string;
  try {
    text = await fs.promises.readFile(fileOf(id), "utf8");
  } catch {
    throw new AppError(IMPORT_FILE_GONE_ERROR, 410);
  }
  const root = JSON.parse(text.replace(/^﻿/, ""));
  cacheRoot(id, root);
  return root;
};

const deleteFile = async (id: string) => {
  rootCache.delete(id);
  await fs.promises.unlink(fileOf(id)).catch(() => undefined);
  await ProviderImport.updateOne({ _id: id }, { $set: { fileDeleted: true } });
};

// uploads nobody ran within a day are removed
const sweepOldFiles = async () => {
  const old = await ProviderImport.find({
    fileDeleted: false,
    status: { $in: ["uploaded", "validated", "failed"] },
    updatedAt: { $lt: new Date(Date.now() - KEEP_UNUSED_FILE_MS) },
  })
    .select("_id")
    .lean();
  for (const row of old) await deleteFile(String(row._id));
};

export const saveUpload = async (buffer: Buffer, fileName: string, userId?: unknown) => {
  let root: unknown;
  try {
    root = JSON.parse(buffer.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new AppError(IMPORT_BAD_JSON_ERROR, 400);
  }
  const analysis = analyseFile(root);
  if (!analysis.lists.length) throw new AppError(IMPORT_NO_LISTS_ERROR, 400);
  if (analysis.lists.reduce((s, l) => s + l.count, 0) > IMPORT_MAX_RECORDS) throw new AppError(IMPORT_TOO_MANY_ERROR, 400);
  await sweepOldFiles().catch(() => undefined);
  const doc = await ProviderImport.create({
    fileName: String(fileName || "import.json").slice(0, 300),
    size: buffer.length,
    native: analysis.native,
    ...(userId ? { createdBy: userId } : {}),
  });
  await fs.promises.mkdir(IMPORT_DIR, { recursive: true });
  await fs.promises.writeFile(fileOf(doc._id), buffer);
  cacheRoot(String(doc._id), root);
  return { import: doc.toObject(), ...analysis };
};

export const analyseStored = async (id: string) => analyseFile(await loadRoot(id));

// ------------------------------------------------------------ mapping

export const parseMapping = (input: unknown): Mapping => {
  const parsed = mappingSchema.safeParse(input);
  if (!parsed.success) throw new AppError(IMPORT_BAD_MAPPING_ERROR, 400);
  return parsed.data;
};

type MappedList = { list: ListMapping; listIndex: number; records: CleanRecord[] };

const mapAll = (root: unknown, mapping: Mapping, limit?: number): MappedList[] =>
  mapping.lists
    .map((list, listIndex) => {
      if (!["doctor", "office", "clinic", "hospital", "pharmacy", "lab", "insurer"].includes(list.kind)) return null;
      const all = recordsAt(root, list.path);
      const source = limit ? all.slice(0, limit) : all;
      const base = list.path || "$";
      return {
        list,
        listIndex,
        records: source.map((rec, i) => cleanRecord(mapRecord(rec, list), list.kind, `${base}[${i}]`)),
      };
    })
    .filter(Boolean) as MappedList[];

// the distinct values a value-mapped field takes in the file (the panel's
// value map editor), with what each becomes without a map
const MAP_FIELDS = new Set(["gender", "type", "sampling", "day", "visitTypes", "mainSpeciality", "specialities", "insurances", "category", "medicalTitle"]);

const distinctValues = (root: unknown, mapping: Mapping) => {
  const out: Record<string, string[]> = {};
  const walk = (records: unknown[], list: ListMapping, key: string) => {
    for (const [field, rule] of Object.entries(list.fields || {})) {
      if (!MAP_FIELDS.has(field)) continue;
      const seen = new Set<string>(out[`${key}:${field}`] || []);
      const plain = { ...rule, valueMap: undefined };
      for (const rec of records.slice(0, 2000)) {
        const v = applyRule(rec, plain);
        const items = Array.isArray(v) ? v : typeof v === "string" && rule.split === undefined && ["specialities", "insurances", "visitTypes"].includes(field) ? v.split(/[,،;|]/) : [v];
        for (const item of items) {
          if (isEmptyValue(item) || typeof item === "object") continue;
          if (seen.size >= 60) break;
          seen.add(String(item).trim());
        }
      }
      out[`${key}:${field}`] = [...seen];
    }
    (list.children || []).forEach((child, i) => {
      const items = records.flatMap((rec) => {
        const v = child.path ? recordsAt(rec, child.path) : [];
        return v;
      });
      walk(items, child, `${key}.${i}`);
    });
  };
  mapping.lists.forEach((list, i) => walk(recordsAt(root, list.path), list, String(i)));
  return out;
};

export const previewMapping = async (id: string, mappingInput: unknown) => {
  const root = await loadRoot(id);
  const mapping = parseMapping(mappingInput);
  const lists = mapAll(root, mapping, PREVIEW_RECORDS).map(({ list, listIndex, records }) => ({
    listIndex,
    kind: list.kind,
    path: list.path,
    total: recordsAt(root, list.path).length,
    records: records.map((r) => ({ path: r.path, externalId: r.externalId, data: r.data, translations: r.translations, children: r.children, issues: [...r.issues, ...allIssues(r).slice(r.issues.length).map((i) => (i.level === "error" ? { ...i, level: "warning" as const } : i))] })),
  }));
  const values = distinctValues(root, mapping);
  // which catalogue entry a name would be matched to (or created)
  const specialities = await specialityIndex();
  const insurers = await nameIndex(Insurance, "name");
  const names: Record<string, { value: string; match: "existing" | "new" | "unknown"; to?: string }[]> = {};
  for (const [key, list] of Object.entries(values)) {
    const field = key.split(":")[1];
    if (field === "mainSpeciality" || field === "specialities")
      names[key] = list.map((v) => {
        const hit = specialities.get(valueKey(v));
        return hit ? { value: v, match: "existing", to: hit.name } : { value: v, match: "new" };
      });
    else if (field === "insurances")
      names[key] = list.map((v) => {
        const hit = insurers.get(valueKey(v));
        return hit ? { value: v, match: "existing", to: hit.name } : { value: v, match: "unknown" };
      });
  }
  return { lists, values, names };
};

// ------------------------------------------------------------ lookups

type Named = { _id: Types.ObjectId; name: string };
const nameIndex = async (model: Model<any>, field: string, filter: Record<string, unknown> = {}) => {
  const rows = await model.find(filter).select(`_id ${field}`).lean<Record<string, any>[]>();
  const map = new Map<string, Named>();
  for (const r of rows) if (r[field]) map.set(valueKey(r[field]), { _id: r._id, name: r[field] });
  return map;
};
const specialityIndex = () => nameIndex(Speciality, "name");

type KindConfig = {
  model: Model<any>;
  activeField: string;
  imageField: string;
  codeField: string;
  categoryModel?: Model<any>;
  hasGeo: boolean;
  hasHours: boolean;
  hasInsurances: boolean;
};

const centreConfig: Record<Exclude<ImportKind, "doctor" | "office">, KindConfig> = {
  clinic: { model: Clinic, activeField: "active", imageField: "image", codeField: "clinicCode", categoryModel: ClinicCategory, hasGeo: true, hasHours: true, hasInsurances: true },
  hospital: { model: Hospital, activeField: "isActive", imageField: "image", codeField: "code", categoryModel: HospitalCategory, hasGeo: true, hasHours: true, hasInsurances: true },
  pharmacy: { model: Pharmacy, activeField: "active", imageField: "avatar", codeField: "licenseNumber", hasGeo: true, hasHours: true, hasInsurances: true },
  lab: { model: ParaClinic, activeField: "active", imageField: "image", codeField: "licenseNumber", categoryModel: ParaClinicCategory, hasGeo: true, hasHours: true, hasInsurances: true },
  insurer: { model: Insurance, activeField: "active", imageField: "image", codeField: "licenseNumber", categoryModel: InsuranceCategory, hasGeo: false, hasHours: false, hasInsurances: false },
};

const modelOfKind = (kind: ImportKind): Model<any> =>
  kind === "doctor" ? DoctorProfile : kind === "office" ? Office : centreConfig[kind].model;

type Ctx = {
  dry: boolean;
  importId?: Types.ObjectId;
  specialities: Map<string, Named>;
  insurers: Map<string, Named>;
  serviceCategories: Map<string, Named>;
  tests: Map<string, Named>;
  categories: Map<Model<any>, Map<string, Named>>;
  // records of this file: "<kind>:<externalId>" -> our id (or "new" in a dry run)
  ids: Map<string, Types.ObjectId | "new">;
  // a centre id -> its kind (memberships name a centre by its externalId only)
  centreKinds: Map<string, "clinic" | "hospital">;
  created: { specialities: Set<string>; tests: Set<string>; categories: Set<string> };
  images: Map<string, string | null>;
  touchedDoctors: Set<string>;
  translationsPending: number;
};

const linkOf = async (kind: ImportKind, externalId?: string) =>
  externalId ? ProviderImportLink.findOne({ kind, externalId }).lean() : null;

// the record a source row is: its link, then the council number, then the slug
const findTarget = async (kind: ImportKind, rec: CleanRecord): Promise<{ doc: any | null; by?: string }> => {
  const model = modelOfKind(kind);
  const link = await linkOf(kind, rec.externalId);
  if (link) {
    const doc = await model.findById(link.target);
    if (doc) return { doc, by: "externalId" };
  }
  if (kind === "doctor" && rec.data.medicalCode) {
    const doc = await DoctorProfile.findOne({ medicalSystemCode: rec.data.medicalCode });
    if (doc) return { doc, by: "medicalCode" };
  }
  if (rec.data.slug) {
    const doc = await model.findOne({ slug: rec.data.slug });
    if (doc) return { doc, by: "slug" };
  }
  return { doc: null };
};

// owned by an account: the provider's own page from then on
const isClaimed = (_kind: ImportKind, doc: any) => !!doc?.get?.("user");

const blank = (v: unknown) => isEmptyValue(v) || (Array.isArray(v) && !v.length);

// sets a field; on a claimed record only an empty one
const put = (doc: any, key: string, value: unknown, claimed: boolean) => {
  if (value === undefined) return;
  if (claimed && !blank(doc.get(key))) return;
  const cur = doc.get(key);
  if (JSON.stringify(cur?.toObject?.() ?? cur) === JSON.stringify(value)) return;
  doc.set(key, value);
};

const localPhone = (p?: string) => (p && p.startsWith("98") ? `0${p.slice(2)}` : p);

const uniqueSlug = async (model: Model<any>, base: string, selfId?: unknown) => {
  const root = slugify(base) || `p-${crypto.randomBytes(3).toString("hex")}`;
  let slug = root;
  let n = 2;
  while (await model.exists({ slug, ...(selfId ? { _id: { $ne: selfId } } : {}) })) slug = `${root}-${n++}`;
  return slug;
};

const setTranslations = (doc: any, translations: Record<string, Record<string, unknown>>, fieldMap: Record<string, string>, claimed: boolean, ctx: Ctx) => {
  const current = (doc.get("translations") || {}) as Record<string, Record<string, unknown>>;
  const next = JSON.parse(JSON.stringify(current)) as Record<string, Record<string, unknown>>;
  let changed = false;
  for (const [loc, bag] of Object.entries(translations || {}))
    for (const [field, value] of Object.entries(bag)) {
      const target = fieldMap[field];
      if (!target) continue;
      if (claimed && !blank(next[loc]?.[target])) continue;
      if (JSON.stringify(next[loc]?.[target]) === JSON.stringify(value)) continue;
      (next[loc] ||= {})[target] = value;
      // given by the source: a manual translation (no machine-source hash)
      if ((next[loc] as Record<string, any>)._src) delete (next[loc] as Record<string, any>)._src[target];
      changed = true;
    }
  if (changed) {
    doc.set("translations", next);
    doc.markModified("translations");
  }
  // the fields left without a translation wait for the machine translation
  ctx.translationsPending++;
};

// a map pin, or the province / city named in the file
const applyPlace = async (doc: any, rec: CleanRecord, claimed: boolean, issues: Issue[], withDivisions = true) => {
  const { lat, lng, province, city } = rec.data;
  if (lat !== undefined && lng !== undefined) {
    if (!(claimed && doc.get("location")?.coordinates?.length)) {
      const cur = doc.get("location")?.coordinates;
      if (!cur || cur[0] !== lng || cur[1] !== lat) doc.set("location", { type: "Point", coordinates: [lng, lat] });
    }
    return;
  }
  if (!withDivisions || (!province && !city)) return;
  const p = province ? await matchDivision("province", { id: "", name: province } as never) : undefined;
  if (province && !p) issues.push({ level: "warning", path: rec.path, field: "province", code: "استان «${1}» در فهرست تقسیمات پیدا نشد", params: [province] });
  const c = city && p ? await matchDivision("city", { id: "", name: city } as never, p) : undefined;
  if (city && p && !c) issues.push({ level: "warning", path: rec.path, field: "city", code: "شهر «${1}» در استان پیدا نشد", params: [city] });
  if (p) put(doc, "province", p, claimed);
  if (c) put(doc, "city", c, claimed);
};

// ------------------------------------------------------------ images

const privateHost = (ip: string) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v === "::";
};

const IMAGE_EXTS = ["jpg", "png", "webp", "gif"];

// a photo / logo URL -> our copy in Public/ (one file per URL, so a second
// run reuses it); null when it can't be fetched (the record goes on without)
const downloadImage = async (url: string, ctx: Ctx): Promise<string | null> => {
  if (ctx.images.has(url)) return ctx.images.get(url)!;
  const base = `import__${crypto.createHash("sha1").update(url).digest("hex").slice(0, 24)}`;
  const existing = IMAGE_EXTS.map((e) => `${base}.${e}`).find((f) => fs.existsSync(path.join(PUBLIC_DIR, f)));
  if (existing) {
    ctx.images.set(url, existing);
    return existing;
  }
  let result: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
    // our own servers and the private network are not fetched on a live server
    if (NODE_ENV === "production") {
      const addresses = await dns.promises.lookup(u.hostname, { all: true });
      if (!addresses.length || addresses.some((a) => privateHost(a.address))) throw new Error("private host");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get("content-length") || 0) > IMAGE_MAX_BYTES) throw new Error("too large");
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > IMAGE_MAX_BYTES) throw new Error("size");
      const ext = sniffExtension(buf, "");
      if (!ext || !IMAGE_EXTS.includes(ext)) throw new Error("not an image");
      const name = `${base}.${ext}`;
      await fs.promises.writeFile(path.join(PUBLIC_DIR, name), buf);
      result = name;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    result = null;
  }
  ctx.images.set(url, result);
  return result;
};

const applyImage = async (doc: any, field: string, url: string | undefined, claimed: boolean, rec: CleanRecord, issues: Issue[], ctx: Ctx, srcField: string) => {
  if (!url || ctx.dry) return;
  if (claimed && doc.get(field)) return;
  const file = await downloadImage(url, ctx);
  if (!file) {
    issues.push({ level: "warning", path: rec.path, field: srcField, code: "تصویر «${1}» دریافت نشد؛ رکورد بدون تصویر وارد شد", params: [url.slice(0, 120)] });
    return;
  }
  put(doc, field, file, claimed);
};

// ------------------------------------------------------------ catalogue entries

const specialityIds = async (names: string[] | undefined, rec: CleanRecord, issues: Issue[], ctx: Ctx) => {
  const ids: Types.ObjectId[] = [];
  for (const name of names || []) {
    const key = valueKey(name);
    let hit = ctx.specialities.get(key);
    if (!hit) {
      // like the forms' inline "create" (NodesSelector creatable)
      ctx.created.specialities.add(name);
      issues.push({ level: "warning", path: rec.path, field: "specialities", code: "تخصص «${1}» در فهرست نبود و ساخته می‌شود", params: [name] });
      if (ctx.dry) continue;
      const sp = await Speciality.create({ name, active: true, slug: await uniqueSlug(Speciality, name) });
      hit = { _id: sp._id, name };
      ctx.specialities.set(key, hit);
    }
    if (!ids.some((i) => i.equals(hit!._id))) ids.push(hit._id);
  }
  return ids;
};

const insurerIds = async (names: string[] | undefined, rec: CleanRecord, issues: Issue[], ctx: Ctx) => {
  const ids: Types.ObjectId[] = [];
  for (const name of names || []) {
    // an insurer of this file, by its id or its name
    const inFile = ctx.ids.get(`insurer:${name}`);
    const hit = ctx.insurers.get(valueKey(name));
    const id = inFile && inFile !== "new" ? inFile : hit?._id;
    if (!id && !inFile) {
      issues.push({ level: "warning", path: rec.path, field: "insurances", code: "بیمه‌ی «${1}» پیدا نشد و کنار گذاشته شد", params: [name] });
      continue;
    }
    if (id && !ids.some((i) => i.equals(id))) ids.push(id);
  }
  return ids;
};

const categoryId = async (model: Model<any> | undefined, name: string | undefined, rec: CleanRecord, issues: Issue[], ctx: Ctx) => {
  if (!model || !name) return undefined;
  let index = ctx.categories.get(model);
  if (!index) {
    index = await nameIndex(model, "name");
    ctx.categories.set(model, index);
  }
  const hit = index.get(valueKey(name));
  if (hit) return hit._id;
  ctx.created.categories.add(name);
  issues.push({ level: "warning", path: rec.path, field: "category", code: "دسته‌ی «${1}» در فهرست نبود و ساخته می‌شود", params: [name] });
  if (ctx.dry) return undefined;
  const c = await model.create({ name, isActive: true, slug: await uniqueSlug(model, name) });
  index.set(valueKey(name), { _id: c._id, name });
  return c._id as Types.ObjectId;
};

// ------------------------------------------------------------ records

type Outcome = { action: "create" | "update" | "unchanged" | "fail"; target?: string; claimed?: boolean; matchedBy?: string; issues: Issue[] };

const saveLink = async (kind: ImportKind, externalId: string | undefined, target: Types.ObjectId, ctx: Ctx, privatePhones?: string[]) => {
  if (!externalId) return;
  ctx.ids.set(`${kind}:${externalId}`, target);
  if (ctx.dry) return;
  await ProviderImportLink.updateOne(
    { kind, externalId },
    {
      $set: { target, ...(ctx.importId ? { lastImport: ctx.importId } : {}) },
      ...(privatePhones?.length ? { $addToSet: { privatePhones: { $each: privatePhones } } } : {}),
    },
    { upsert: true },
  );
};

const slugFor = async (model: Model<any>, doc: any, rec: CleanRecord, name: string, claimed: boolean, issues: Issue[], ctx: Ctx) => {
  if (claimed && doc.get("slug")) return;
  const wanted = rec.data.slug as string | undefined;
  if (wanted) {
    if (doc.get("slug") === wanted) return;
    const clean = slugify(wanted);
    const taken = await model.exists({ slug: clean, _id: { $ne: doc._id } });
    if (!taken && clean) return doc.set("slug", clean);
    const alt = ctx.dry ? `${clean}-2` : await uniqueSlug(model, clean || name, doc._id);
    issues.push({ level: "warning", path: rec.path, field: "slug", code: "نامک «${1}» برای رکورد دیگری است؛ «${2}» گذاشته شد", params: [wanted, alt] });
    return doc.set("slug", alt);
  }
  if (!doc.get("slug")) doc.set("slug", ctx.dry ? slugify(name) : await uniqueSlug(model, name, doc._id));
};

const failedSave = (err: unknown, rec: CleanRecord, issues: Issue[]): Outcome => {
  const e = err as { message?: string; code?: number; errors?: Record<string, { path?: string }> };
  let code = e?.message || String(err);
  if (e?.code === 11000) code = "رکورد تکراری: یک فیلد یکتا (مثل نامک) برای رکورد دیگری است";
  issues.push({ level: "error", path: rec.path, code: code.slice(0, 300) });
  return { action: "fail", issues };
};

const SETTINGS: Record<ImportVisitType, Model<any>> = {
  inPerson: InPersonSettings,
  videoCall: VideoCallSettings,
  textChat: TextChatSettings,
  voiceCall: VoiceCallSettings,
};

// weekly hours rows -> the doctor's shifts at one office (minutes of the
// Tehran day; no overlap within a day, as the panel's own hours form)
const shiftsFor = (rows: CleanRecord[], officeId: Types.ObjectId | undefined, doctorId: Types.ObjectId | undefined, offered: Map<ImportVisitType, number | undefined>, issues: Issue[]) => {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row.ok) continue;
    const types: ImportVisitType[] = row.data.visitTypes?.length
      ? row.data.visitTypes
      : offered.has("inPerson")
        ? ["inPerson"]
        : ([...offered.keys()].length ? [...offered.keys()] : ["inPerson"]);
    const duration = row.data.slotMinutes || offered.get(types[0]) || 15;
    for (const day of row.data.day as number[])
      for (const r of row.data.ranges as { from: number; to: number }[]) {
        const end = r.to === 0 ? 1440 : r.to;
        if (end <= r.from) {
          issues.push({ level: "warning", path: row.path, field: "to", code: ISSUE.endBeforeStart });
          continue;
        }
        out.push({ day, start: r.from, end, office: officeId, doctor: doctorId, duration, gap: 0, sessionTypes: types, patientTypes: ["oldPatient", "newPatient"] });
      }
  }
  return out;
};

const overlaps = (a: { day: unknown; start: unknown; end: unknown }, b: { day: unknown; start: unknown; end: unknown }) =>
  a.day === b.day && (a.start as number) < (b.end as number) && (b.start as number) < (a.end as number);

const officeFields = (doc: any, rec: CleanRecord, claimed: boolean) => {
  put(doc, "name", rec.data.name, claimed);
  put(doc, "address", rec.data.address, claimed);
  put(doc, "addressDetail", rec.data.addressDetail?.slice(0, 200), claimed);
  put(doc, "tel", localPhone(rec.data.phone), claimed);
  if (!claimed || doc.isNew) put(doc, "active", rec.data.active ?? true, claimed);
};

const doctorRecord = async (rec: CleanRecord, ctx: Ctx): Promise<Outcome> => {
  const issues: Issue[] = [];
  const { doc: found, by } = await findTarget("doctor", rec);
  const claimed = isClaimed("doctor", found);
  const isNew = !found;
  const doc: any = found || new DoctorProfile({ claimed: false, autoPublish: false, active: false });
  if (claimed) issues.push({ level: "warning", path: rec.path, code: "این پروفایل صاحب دارد (ادعا شده)؛ فقط فیلدهای خالی آن پر می‌شود" });
  const d = rec.data;
  put(doc, "firstName", d.firstName, claimed);
  put(doc, "lastName", d.lastName, claimed);
  put(doc, "gender", d.gender, claimed);
  if (d.medicalCode && (!doc.get("medicalSystemCode") || !claimed)) {
    if (doc.get("medicalSystemCode") !== d.medicalCode) {
      const other = await DoctorProfile.exists({ medicalSystemCode: d.medicalCode, _id: { $ne: doc._id } });
      if (other) issues.push({ level: "error", path: rec.path, field: "medicalCode", code: "شماره‌ی نظام پزشکی «${1}» برای پزشک دیگری ثبت شده است", params: [d.medicalCode] });
      else doc.set("medicalSystemCode", d.medicalCode);
    }
  }
  if (d.medicalTitle) {
    const title = medicalSystemTitles.find((t) => valueKey(t) === valueKey(d.medicalTitle));
    if (title) put(doc, "medicalSystemTitle", title, claimed);
    else issues.push({ level: "warning", path: rec.path, field: "medicalTitle", code: ISSUE.invalid, params: [d.medicalTitle] });
  }
  const specs = await specialityIds(d.specialities, rec, issues, ctx);
  if (specs.length && (!claimed || !(doc.get("specialities") || []).length)) {
    doc.set("specialities", specs);
    doc.set("mainSpeciality", specs[0]);
  }
  put(doc, "introduction", d.bio, claimed);
  put(doc, "achivements", d.education, claimed);
  if (d.website) put(doc, "website", normalizeWebsite(d.website) || undefined, claimed);
  put(doc, "landLine", localPhone(d.phone), claimed);
  if (d.services?.length) {
    const ids = (d.services as string[]).map((s) => ctx.serviceCategories.get(valueKey(s))?._id).filter(Boolean);
    const missing = (d.services as string[]).filter((s) => !ctx.serviceCategories.get(valueKey(s)));
    for (const m of missing) issues.push({ level: "warning", path: rec.path, field: "services", code: "خدمت «${1}» در کاتالوگ خدمات نیست و کنار گذاشته شد", params: [m] });
    if (ids.length) put(doc, "serviceCategories", ids, claimed);
  }
  setTranslations(doc, rec.translations, { firstName: "firstName", lastName: "lastName", bio: "introduction", education: "achivements", address: "address" }, claimed, ctx);
  // dr-<name>, in Latin letters when the file gives the English name
  const en = rec.translations.en || {};
  const slugName = en.firstName && en.lastName ? `${en.firstName} ${en.lastName}` : `${d.firstName || ""} ${d.lastName || ""}`;
  await slugFor(DoctorProfile, doc, rec, `dr ${slugName}`, claimed, issues, ctx);
  // a public listing, unclaimed: shown with the shared card, not bookable
  // until the doctor claims it. No speciality = no page (the publish rule)
  if (!claimed) {
    const wantActive = d.active ?? true;
    const hasSpec = specs.length || (doc.get("specialities") || []).length || (ctx.dry && (d.specialities || []).length);
    if (wantActive && !hasSpec) issues.push({ level: "warning", path: rec.path, field: "mainSpeciality", code: "پزشک بدون تخصص به‌صورت پیش‌نویس (غیرفعال) وارد می‌شود" });
    doc.set("active", !!(wantActive && hasSpec));
    if (doc.isNew) doc.set("autoPublish", false);
  }
  if (issues.some((i) => i.level === "error")) return { action: "fail", issues };
  // what the doctor points at: insurers and centres (of this file or imported before)
  const ins = await insurerIds(d.insurances, rec, issues, ctx);
  const memberOf = new Map<string, { kind: "clinic" | "hospital"; id: Types.ObjectId }>();
  for (const ext of (d.memberships || []) as string[]) {
    const centre = await centreByExternalId(ext, ctx);
    if (!centre) {
      issues.push({ level: "warning", path: rec.path, field: "memberships", code: "مرکز با شناسه‌ی «${1}» پیدا نشد؛ عضویت ساخته نشد", params: [ext] });
      continue;
    }
    memberOf.set(ext, centre);
  }
  if (claimed && memberOf.size) issues.push({ level: "warning", path: rec.path, field: "memberships", code: "عضویت پزشک ادعاشده در مراکز را خود پزشک یا مرکز تعیین می‌کند؛ ساخته نشد" });
  if (ctx.dry) {
    if (rec.externalId) ctx.ids.set(`doctor:${rec.externalId}`, found?._id || "new");
    return { action: isNew ? "create" : "update", claimed, matchedBy: by, target: found ? String(found._id) : undefined, issues };
  }
  await applyImage(doc, "avatar", d.photo, claimed, rec, issues, ctx, "photo");
  const changed = isNew || doc.isModified();
  try {
    if (doc.isModified() || isNew) await doc.save();
  } catch (err) {
    return failedSave(err, rec, issues);
  }
  const doctorId = doc._id as Types.ObjectId;
  await saveLink("doctor", rec.externalId, doctorId, ctx, d.privatePhones);
  let childChanged = false;

  // visit types and their prices
  const offered = new Map<ImportVisitType, number | undefined>();
  for (const vt of rec.children.visitTypes || []) {
    if (!vt.ok) continue;
    offered.set(vt.data.type, vt.data.duration);
    const model = SETTINGS[vt.data.type as ImportVisitType];
    const cur = await model.findOne({ doctor: doctorId });
    if (cur && claimed) continue;
    const next = { price: vt.data.price, active: vt.data.active ?? true };
    if (!cur || cur.price !== next.price || cur.active !== next.active) {
      await model.updateOne({ doctor: doctorId }, { $set: next }, { upsert: true });
      childChanged = true;
    }
  }

  // insurances the doctor accepts
  if (ins.length && !(claimed && (await DoctorInsurance.exists({ doctor: doctorId }))))
    for (const insurance of ins) {
      const r = await DoctorInsurance.updateOne({ doctor: doctorId, insurance }, { $setOnInsert: { doctor: doctorId, insurance } }, { upsert: true });
      if (r.upsertedCount) childChanged = true;
    }

  // memberships of the file's (or earlier imported) clinics / hospitals
  for (const centre of claimed ? [] : memberOf.values()) {
    const model: Model<any> = centre.kind === "clinic" ? ClinicDoctor : HospitalDoctor;
    const r = await model.updateOne({ [centre.kind]: centre.id, doctor: doctorId }, { $setOnInsert: { [centre.kind]: centre.id, doctor: doctorId } }, { upsert: true });
    if (r.upsertedCount) childChanged = true;
  }

  // offices: the file's list, or the doctor's one address
  let offices = rec.children.offices || [];
  if (!offices.length && (d.address || d.lat !== undefined))
    offices = [
      {
        kind: "office",
        path: rec.path,
        externalId: `${rec.externalId}#1`,
        data: { address: d.address, lat: d.lat, lng: d.lng, phone: d.phone, province: d.province, city: d.city },
        translations: {},
        children: {},
        issues: [],
        ok: true,
      },
    ];
  const officeOutcome = await officesFor(doctorId, offices, offered, memberOf, claimed, rec, issues, ctx);
  childChanged ||= officeOutcome;
  if (officeOutcome) ctx.touchedDoctors.add(String(doctorId));
  return { action: isNew ? "create" : changed || childChanged ? "update" : "unchanged", target: String(doctorId), claimed, matchedBy: by, issues };
};

const centreByExternalId = async (ext: string, ctx: Ctx): Promise<{ kind: "clinic" | "hospital"; id: Types.ObjectId } | null> => {
  for (const kind of ["clinic", "hospital"] as const) {
    const id = ctx.ids.get(`${kind}:${ext}`);
    if (id && id !== "new") return { kind, id };
    if (id === "new") return { kind, id: new Types.ObjectId() };
    const link = await linkOf(kind, ext);
    if (link && (await centreConfig[kind].model.exists({ _id: link.target }))) return { kind, id: link.target };
  }
  return null;
};

const officesFor = async (
  doctorId: Types.ObjectId,
  offices: CleanRecord[],
  offered: Map<ImportVisitType, number | undefined>,
  memberOf: Map<string, { kind: "clinic" | "hospital"; id: Types.ObjectId }>,
  claimed: boolean,
  rec: CleanRecord,
  issues: Issue[],
  ctx: Ctx,
): Promise<boolean> => {
  if (!offices.length) return false;
  // a claimed doctor's offices and hours are theirs: only a doctor with
  // none gets the file's
  if (claimed && (await Office.exists({ doctor: doctorId }))) {
    issues.push({ level: "warning", path: rec.path, field: "offices", code: "مطب‌ها و ساعت‌های کاری پزشک ادعاشده دست نخورد" });
    return false;
  }
  let changed = false;
  const newShifts: Record<string, unknown>[] = [];
  const officeIds: Types.ObjectId[] = [];
  for (const office of offices) {
    if (!office.ok) continue;
    issues.push(...allIssues(office).filter((i) => i.level === "warning" && !issues.includes(i)));
    const link = await linkOf("office", office.externalId);
    let doc: any = link ? await Office.findOne({ _id: link.target, doctor: doctorId }) : null;
    const isNew = !doc;
    doc ||= new Office({ doctor: doctorId, active: true });
    officeFields(doc, office, false);
    await applyPlace(doc, office, false, issues, false);
    const centreExt = office.data.centre as string | undefined;
    if (centreExt) {
      const centre = memberOf.get(centreExt) || (await centreByExternalId(centreExt, ctx));
      const member =
        centre && (await (centre.kind === "clinic" ? ClinicDoctor : HospitalDoctor).exists({ [centre.kind]: centre.id, doctor: doctorId }));
      if (centre && member) put(doc, centre.kind, centre.id, false);
      else issues.push({ level: "warning", path: office.path, field: "centre", code: "مطب به مرکز «${1}» وصل نشد: پزشک عضو آن مرکز نیست", params: [centreExt] });
    }
    try {
      if (isNew || doc.isModified()) {
        await doc.save();
        changed = true;
      }
    } catch (err) {
      issues.push({ level: "error", path: office.path, code: String((err as Error).message).slice(0, 300) });
      continue;
    }
    // no point and the doctor has no division yet: the office's province /
    // city names fill the doctor's (the pin does it by itself otherwise)
    if (office.data.lat === undefined && (office.data.province || office.data.city)) {
      const prof: any = await DoctorProfile.findById(doctorId);
      if (prof) {
        await applyPlace(prof, office, true, issues);
        if (prof.isModified()) await prof.save().catch(() => undefined);
      }
    }
    await saveLink("office", office.externalId, doc._id, ctx);
    officeIds.push(doc._id);
    const rows = office.children.hours || [];
    for (const row of rows) if (!row.ok) issues.push(...asWarnings(row.issues));
    newShifts.push(...shiftsFor(rows, doc._id, doctorId, offered, issues));
  }
  if (newShifts.length || officeIds.length) {
    // the hours of these offices are the file's; other offices keep theirs
    const others = await DoctorShift.find({ doctor: doctorId, office: { $nin: officeIds } }).lean();
    const kept: Record<string, unknown>[] = [];
    for (const s of newShifts) {
      if ([...others, ...kept].some((o) => overlaps(o as never, s as never))) {
        issues.push({ level: "warning", path: rec.path, field: "hours", code: "بازه‌ی ساعت کاری با بازه‌ی دیگری هم‌پوشانی داشت و کنار گذاشته شد" });
        continue;
      }
      kept.push(s);
    }
    const before = await DoctorShift.find({ doctor: doctorId, office: { $in: officeIds } }).select("day start end office duration sessionTypes").lean();
    const sig = (list: Record<string, unknown>[]) =>
      list.map((s) => `${s.office}|${s.day}|${s.start}|${s.end}|${s.duration}|${[...((s.sessionTypes as string[]) || [])].sort()}`).sort().join(";");
    if (sig(before as never) !== sig(kept)) {
      await DoctorShift.deleteMany({ doctor: doctorId, office: { $in: officeIds } });
      if (kept.length) await DoctorShift.insertMany(kept);
      changed = true;
    }
  }
  return changed;
};

// a top-level office row (offices: [...] with `doctor`)
const officeRecord = async (rec: CleanRecord, ctx: Ctx): Promise<Outcome> => {
  const issues: Issue[] = [];
  const ext = rec.data.doctor as string;
  const inFile = ctx.ids.get(`doctor:${ext}`);
  const link = inFile ? null : await linkOf("doctor", ext);
  const doctorId = inFile && inFile !== "new" ? inFile : link?.target;
  if (!doctorId && inFile !== "new") {
    issues.push({ level: "error", path: rec.path, field: "doctor", code: "پزشک با شناسه‌ی «${1}» پیدا نشد", params: [ext] });
    return { action: "fail", issues };
  }
  const existing = await linkOf("office", rec.externalId);
  if (ctx.dry || !doctorId) return { action: existing ? "update" : "create", issues };
  const doctor: any = await DoctorProfile.findById(doctorId);
  if (!doctor) return { action: "fail", issues: [{ level: "error", path: rec.path, field: "doctor", code: "پزشک با شناسه‌ی «${1}» پیدا نشد", params: [ext] }] };
  const offered = new Map<ImportVisitType, number | undefined>();
  for (const [type, model] of Object.entries(SETTINGS))
    if (await model.exists({ doctor: doctorId, active: true })) offered.set(type as ImportVisitType, undefined);
  const changed = await officesFor(doctorId, [rec], offered, new Map(), isClaimed("doctor", doctor), rec, issues, ctx);
  if (changed) ctx.touchedDoctors.add(String(doctorId));
  const link2 = await linkOf("office", rec.externalId);
  return { action: existing ? (changed ? "update" : "unchanged") : "create", target: link2 ? String(link2.target) : undefined, issues };
};

// a child row's problems, reported on the record without failing it
const asWarnings = (list: Issue[]): Issue[] => list.map((i) => (i.level === "error" ? { ...i, level: "warning" } : i));

const hoursOf = (rows: CleanRecord[], issues: Issue[]) => {
  const days = Array.from({ length: 7 }, () => ({ ranges: [] as { start: number; end: number }[] }));
  for (const row of rows) {
    if (!row.ok) {
      issues.push(...asWarnings(row.issues));
      continue;
    }
    for (const day of row.data.day as number[])
      for (const r of row.data.ranges as { from: number; to: number }[])
        days[day].ranges.push({ start: r.from, end: r.to === 0 ? 1440 : r.to });
  }
  try {
    return normalizeOpeningHours({ days, exceptions: [] });
  } catch {
    issues.push({ level: "warning", path: rows[0]?.path || "", field: "hours", code: "ساعت‌های کاری مرکز هم‌پوشانی یا بازه‌ی نادرست داشت و وارد نشد" });
    return undefined;
  }
};

const centreRecord = async (kind: Exclude<ImportKind, "doctor" | "office">, rec: CleanRecord, ctx: Ctx): Promise<Outcome> => {
  const cfg = centreConfig[kind];
  const issues: Issue[] = [];
  const { doc: found, by } = await findTarget(kind, rec);
  const claimed = isClaimed(kind, found);
  const isNew = !found;
  const doc: any = found || new cfg.model({});
  if (claimed) issues.push({ level: "warning", path: rec.path, code: "این مرکز صاحب دارد؛ فقط فیلدهای خالی آن پر می‌شود" });
  const d = rec.data;
  put(doc, "name", d.name, claimed);
  put(doc, "summary", d.summary, claimed);
  if (kind !== "insurer" || d.address) put(doc, "address", d.address, claimed);
  put(doc, "phone", localPhone(d.phone), claimed);
  if (d.website && (kind === "clinic" || kind === "hospital" || kind === "insurer")) put(doc, "website", normalizeWebsite(d.website) || undefined, claimed);
  if (d.email && (kind === "clinic" || kind === "hospital")) put(doc, "mail", d.email, claimed);
  if (d.personnelCount !== undefined && kind !== "pharmacy" && kind !== "insurer") put(doc, "personelCount", Math.round(d.personnelCount), claimed);
  if (kind === "hospital" && d.beds !== undefined) put(doc, "bedCount", Math.round(d.beds), claimed);
  if ((kind === "clinic" || kind === "hospital") && d.services) put(doc, "services", d.services, claimed);
  if (kind === "lab" && d.onlineResults !== undefined) put(doc, "onlineResponse", d.onlineResults, claimed);
  if (kind === "insurer") {
    if (d.basic !== undefined) put(doc, "isBasic", d.basic, claimed);
    put(doc, "coverages", d.coverages, claimed);
    put(doc, "advantages", d.advantages, claimed);
  }
  const cat = await categoryId(cfg.categoryModel, d.category, rec, issues, ctx);
  if (cat) put(doc, "category", cat, claimed);
  if (cfg.hasInsurances && d.insurances) {
    const ins = await insurerIds(d.insurances, rec, issues, ctx);
    if (ins.length) put(doc, "insurances", ins, claimed);
  }
  await applyPlace(doc, rec, claimed, issues, cfg.hasGeo);
  if (cfg.hasHours) {
    const rows = rec.children.hours || [];
    if (rows.length && !(claimed && doc.get("openingHours")?.days?.length)) {
      const hours = hoursOf(rows, issues);
      if (hours) {
        doc.set("openingHours", hours);
        if (d.roundTheClock === undefined) doc.set("isRoundTheClock", hours.days.every((x: { ranges: { start: number; end: number }[] }) => x.ranges.some((r) => r.start === 0 && r.end === 1440)));
      }
    }
    if (d.roundTheClock !== undefined && !rows.length) put(doc, "isRoundTheClock", d.roundTheClock, claimed);
  }
  if (!claimed && (isNew || d.active !== undefined)) doc.set(cfg.activeField, d.active ?? true);
  setTranslations(
    doc,
    rec.translations,
    { name: "name", summary: "summary", address: "address", services: "services", coverages: "coverages", advantages: "advantages" },
    claimed,
    ctx,
  );
  await slugFor(cfg.model, doc, rec, d.name, claimed, issues, ctx);
  if (issues.some((i) => i.level === "error")) return { action: "fail", issues };
  if (ctx.dry) {
    if (rec.externalId) ctx.ids.set(`${kind}:${rec.externalId}`, found?._id || "new");
    if (kind === "insurer") {
      ctx.ids.set(`insurer:${d.name}`, found?._id || "new");
    }
    for (const t of rec.children.tests || []) if (t.ok && !ctx.tests.get(valueKey(t.data.name))) ctx.created.tests.add(t.data.name);
    return { action: isNew ? "create" : "update", claimed, matchedBy: by, target: found ? String(found._id) : undefined, issues };
  }
  await applyImage(doc, cfg.imageField, d.logo, claimed, rec, issues, ctx, "logo");
  // the licence number is written only through the licence paths
  // (Lib/centreLicenceLock.ts): the import fills an empty one, it never
  // sets the verified tick
  const code = d.licenseNumber && !doc.get(cfg.codeField) ? String(d.licenseNumber).slice(0, 60) : undefined;
  if (code) doc.set(cfg.codeField, code);
  const changed = isNew || doc.isModified();
  try {
    if (changed) await (code ? withCentreLicenceWrite(() => doc.save()) : doc.save());
  } catch (err) {
    return failedSave(err, rec, issues);
  }
  await saveLink(kind, rec.externalId, doc._id, ctx, d.privatePhones);
  if (kind === "insurer") {
    ctx.ids.set(`insurer:${d.name}`, doc._id);
    ctx.insurers.set(valueKey(d.name), { _id: doc._id, name: d.name });
  }
  let childChanged = false;
  if (kind === "lab") {
    for (const t of rec.children.tests || []) {
      if (!t.ok) {
        issues.push(...asWarnings(t.issues));
        continue;
      }
      let test = ctx.tests.get(valueKey(t.data.name));
      if (!test) {
        ctx.created.tests.add(t.data.name);
        const created = await Test.create({ name: t.data.name, isActive: true, slug: await uniqueSlug(Test, t.data.name) });
        test = { _id: created._id, name: t.data.name };
        ctx.tests.set(valueKey(t.data.name), test);
      }
      const cur = await ParaClinicTest.findOne({ paraClinic: doc._id, test: test._id });
      if (cur && claimed) continue;
      const next = { price: t.data.price, ...(t.data.readyTime ? { readyTime: t.data.readyTime } : {}), ...(t.data.sampling ? { sampling: t.data.sampling } : {}) };
      if (!cur || cur.price !== next.price || (next.readyTime && cur.readyTime !== next.readyTime) || (next.sampling && cur.sampling !== next.sampling)) {
        await ParaClinicTest.updateOne({ paraClinic: doc._id, test: test._id }, { $set: next, $setOnInsert: { isActive: true } }, { upsert: true });
        childChanged = true;
      }
    }
  }
  return { action: isNew ? "create" : changed || childChanged ? "update" : "unchanged", target: String(doc._id), claimed, matchedBy: by, issues };
};

// ------------------------------------------------------------ run

export type ReportRecord = {
  kind: string;
  path: string;
  externalId?: string;
  name?: string;
  action: Outcome["action"] | "skip";
  target?: string;
  claimed?: boolean;
  matchedBy?: string;
  issues: Issue[];
};

export type ImportReport = {
  mode: "validate" | "apply";
  totals: { records: number; create: number; update: number; unchanged: number; fail: number; skip: number; warnings: number; errors: number };
  byKind: Record<string, { records: number; create: number; update: number; unchanged: number; fail: number; skip: number }>;
  records: ReportRecord[];
  created: { specialities: string[]; tests: string[]; categories: string[] };
  translationsPending: number;
  startedAt: string;
  finishedAt?: string;
};

const nameOfRecord = (r: CleanRecord) =>
  r.kind === "doctor" ? [r.data.firstName, r.data.lastName].filter(Boolean).join(" ") || r.data.fullName : r.data.name || r.data.address;

const newCtx = async (dry: boolean, importId?: Types.ObjectId): Promise<Ctx> => ({
  dry,
  importId,
  specialities: await specialityIndex(),
  insurers: await nameIndex(Insurance, "name"),
  serviceCategories: await nameIndex(ServiceCategory, "title", { isActive: true }),
  tests: await nameIndex(Test, "name"),
  categories: new Map(),
  ids: new Map(),
  centreKinds: new Map(),
  created: { specialities: new Set(), tests: new Set(), categories: new Set() },
  images: new Map(),
  touchedDoctors: new Set(),
  translationsPending: 0,
});

export const runImport = async (
  root: unknown,
  mapping: Mapping,
  mode: "validate" | "apply",
  opts: { importId?: Types.ObjectId; progress?: (p: { phase: string; processed: number; total: number }) => Promise<void> | void } = {},
): Promise<ImportReport> => {
  const startedAt = new Date().toISOString();
  const lists = mapAll(root, mapping);
  const all = lists.flatMap((l) => l.records);
  const report: ImportReport = {
    mode,
    totals: { records: 0, create: 0, update: 0, unchanged: 0, fail: 0, skip: 0, warnings: 0, errors: 0 },
    byKind: {},
    records: [],
    created: { specialities: [], tests: [], categories: [] },
    translationsPending: 0,
    startedAt,
  };
  const ctx = await newCtx(mode === "validate", opts.importId);
  // ids and council numbers repeated in the file: the first row wins
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const ordered = applyOrder.flatMap((kind) => all.filter((r) => r.kind === kind));
  let processed = 0;
  for (const rec of ordered) {
    // a bad child row (an office, an hours row, a price) is left out and
    // reported; only the record's own errors stop the record
    const issues = [...rec.issues, ...allIssues(rec).slice(rec.issues.length).map((i) => (i.level === "error" ? { ...i, level: "warning" as const } : i))];
    let outcome: Outcome | { action: "skip"; issues: Issue[] } = { action: "skip", issues };
    const idKey = `${rec.kind}:${rec.externalId}`;
    if (rec.externalId && seenIds.has(idKey)) {
      issues.push({ level: "error", path: rec.path, field: "externalId", code: ISSUE.duplicateId, params: [rec.externalId] });
    } else if (rec.kind === "doctor" && rec.data.medicalCode && seenCodes.has(rec.data.medicalCode)) {
      issues.push({ level: "error", path: rec.path, field: "medicalCode", code: ISSUE.duplicateCode, params: [rec.data.medicalCode] });
    }
    const ownErrors = issues.some((i) => i.level === "error");
    if (rec.externalId) seenIds.add(idKey);
    if (rec.kind === "doctor" && rec.data.medicalCode) seenCodes.add(rec.data.medicalCode);
    if (ownErrors) outcome = { action: "fail", issues };
    else {
      try {
        const res =
          rec.kind === "doctor"
            ? await doctorRecord(rec, ctx)
            : rec.kind === "office"
              ? await officeRecord(rec, ctx)
              : await centreRecord(rec.kind as Exclude<ImportKind, "doctor" | "office">, rec, ctx);
        // the child rows' problems were reported with the record already
        const extra = res.issues.filter((i) => !issues.some((j) => j.path === i.path && j.code === i.code && j.field === i.field));
        outcome = { ...res, issues: [...issues, ...extra] };
      } catch (err) {
        outcome = failedSave(err, rec, issues);
      }
    }
    const k = (report.byKind[rec.kind] ||= { records: 0, create: 0, update: 0, unchanged: 0, fail: 0, skip: 0 });
    k.records++;
    k[outcome.action]++;
    report.totals.records++;
    report.totals[outcome.action]++;
    report.totals.warnings += outcome.issues.filter((i) => i.level === "warning").length;
    report.totals.errors += outcome.issues.filter((i) => i.level === "error").length;
    if (report.records.length < MAX_REPORT_RECORDS)
      report.records.push({
        kind: rec.kind,
        path: rec.path,
        externalId: rec.externalId,
        name: nameOfRecord(rec),
        action: outcome.action,
        target: (outcome as Outcome).target,
        claimed: (outcome as Outcome).claimed,
        matchedBy: (outcome as Outcome).matchedBy,
        issues: outcome.issues.slice(0, 50),
      });
    processed++;
    if (opts.progress && (processed % 10 === 0 || processed === ordered.length))
      await opts.progress({ phase: rec.kind, processed, total: ordered.length });
  }
  if (mode === "apply") {
    // availability from the new weekly hours (as the panel's hours form)
    if (ctx.touchedDoctors.size) {
      await opts.progress?.({ phase: "availability", processed, total: ordered.length });
      const now = new Date();
      const last = new Date();
      last.setDate(last.getDate() + (await getBookingHorizonDays()));
      for (const id of ctx.touchedDoctors) {
        const doctor = await DoctorProfile.findById(id);
        if (doctor) await updateDoctorAvailability({ doctor, startDate: now, endDate: last }).catch(() => undefined);
      }
    }
    clearDirectoryCache();
    clearSeoCache();
  }
  report.created = {
    specialities: [...ctx.created.specialities],
    tests: [...ctx.created.tests],
    categories: [...ctx.created.categories],
  };
  report.translationsPending = ctx.translationsPending;
  report.finishedAt = new Date().toISOString();
  return report;
};

// ------------------------------------------------------------ jobs

let running: string | null = null;

const summaryOf = (r: ImportReport) => ({ totals: r.totals, byKind: r.byKind });

export const startJob = async (id: string, mappingInput: unknown, mode: "validate" | "apply", actor?: { _id: unknown; role?: string }, meta: { ip?: string; path?: string; template?: string } = {}) => {
  const mapping = parseMapping(mappingInput);
  if (!mapping.lists.length) throw new AppError(IMPORT_BAD_MAPPING_ERROR, 400);
  if (running) throw new AppError(IMPORT_RUNNING_ERROR, 409);
  const row = await ProviderImport.findById(id);
  if (!row) throw new AppError("ورود گروهی پیدا نشد", 404);
  if (row.fileDeleted) throw new AppError(IMPORT_FILE_GONE_ERROR, 410);
  if (row.status === "validating" || row.status === "applying") throw new AppError(IMPORT_RUNNING_ERROR, 409);
  const root = await loadRoot(id);
  // claim the run (two clicks, two tabs: one job)
  const claimed = await ProviderImport.findOneAndUpdate(
    { _id: id, status: { $nin: ["validating", "applying"] } },
    {
      $set: {
        status: mode === "apply" ? "applying" : "validating",
        mapping,
        ...(meta.template ? { template: meta.template } : {}),
        progress: { phase: "starting", processed: 0, total: 0 },
        startedAt: new Date(),
        error: undefined,
      },
    },
    { new: true },
  );
  if (!claimed) throw new AppError(IMPORT_RUNNING_ERROR, 409);
  running = id;
  setImmediate(async () => {
    try {
      const report = await runImport(root, mapping, mode, {
        importId: claimed._id,
        progress: (p) => ProviderImport.updateOne({ _id: id }, { $set: { progress: p } }).then(() => undefined),
      });
      await ProviderImport.updateOne(
        { _id: id },
        {
          $set: {
            status: mode === "apply" ? "done" : "validated",
            [mode === "apply" ? "report" : "validation"]: report,
            finishedAt: new Date(),
            progress: { phase: "done", processed: report.totals.records, total: report.totals.records },
          },
        },
      );
      if (mode === "apply") {
        await deleteFile(id);
        if (actor?._id)
          await AdminAuditLog.create({
            actor: actor._id,
            actorRole: actor.role || "admin",
            action: "migrate",
            target: "import/providers",
            targetId: id,
            method: "POST",
            path: meta.path || "/api/v1/admin/import/providers",
            fields: ["importId", "mapping"],
            details: { file: claimed.fileName, ...summaryOf(report) },
            status: 202,
            ip: meta.ip,
          }).catch(() => undefined);
      }
    } catch (err) {
      console.error("[providerImport] failed", err);
      await ProviderImport.updateOne(
        { _id: id },
        { $set: { status: "failed", error: String((err as Error)?.message || err).slice(0, 500), finishedAt: new Date() } },
      ).catch(() => undefined);
    } finally {
      running = null;
    }
  });
  return claimed.toObject();
};

// a server restart mid-run leaves the row "running": it is failed on boot
export const recoverStaleImports = () =>
  ProviderImport.updateMany(
    { status: { $in: ["validating", "applying"] } },
    { $set: { status: "failed", error: "interrupted", finishedAt: new Date() } },
  ).catch(() => undefined);

export const removeImport = async (id: string) => {
  const row = await ProviderImport.findById(id);
  if (!row) throw new AppError("ورود گروهی پیدا نشد", 404);
  if (row.status === "validating" || row.status === "applying") throw new AppError(IMPORT_RUNNING_ERROR, 409);
  await deleteFile(id);
  return row;
};

export type { IProviderImport, AnyKind };
export { kindFields };
