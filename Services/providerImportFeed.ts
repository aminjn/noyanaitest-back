import dns from "dns";
import net from "net";
import AppError from "../Lib/AppError";
import { IMPORT_MAX_RECORDS } from "../Lib/providerImport/catalog";
import { detectBuiltinTemplate, DRDR_FIELDS, DRDR_PHARMACY_FIELDS } from "../Lib/providerImport/partners";
import { findRecordLists } from "../Lib/providerImport/source";
import { maskSecret } from "../Lib/secretMask";
import ProviderImport from "../Models/ProviderImport";
import ProviderImportFeed, { IProviderImportFeed } from "../Models/ProviderImportFeed";
import { saveUpload, startJob } from "./providerImport";

// A contracted partner's live feed (Models/ProviderImportFeed.ts): the
// server reads it itself instead of the admin downloading and uploading a
// file. One run:
//  1. pages of `limit` records from `offset` 0 on, following the feed's
//     `next_offset` (or the next page while a page comes back full), with
//     `since` = the start of the last run that finished (an hour earlier:
//     a record changed while that run read is read again - the import is
//     keyed, so a second read only updates);
//  2. the records, in the partner file's shape, become an ordinary upload;
//     the partner's built-in template is recognised from the fields
//     (Lib/providerImport/partners.ts) - a feed that matches none is
//     refused rather than guessed;
//  3. the import runs (Services/providerImport.ts startJob), with its row
//     and report in the history like a file's; `syncedUntil` moves on only
//     when it finished.
// Every `intervalHours` (the 10-minute tick below) or on «همگام‌سازی الان».
//
// Benchmark: Doctolib and Docplanner take a partner's practice directory
// through a scheduled, incremental API sync rather than file drops; the
// same here, through the same keyed import as a file, so a claimed profile
// is never overwritten.

export const FEED_BAD_URL_ERROR = "آدرس منبع معتبر نیست";
export const FEED_FETCH_ERROR = "منبع خودکار پاسخ معتبری نداد";
export const FEED_NO_TEMPLATE_ERROR = "داده‌های منبع با هیچ‌یک از قالب‌های شریک جور نیست";
// the same, with what the feed's records hold (the admin sends it on)
export const FEED_NO_TEMPLATE_FIELDS_ERROR = "داده‌های منبع با هیچ‌یک از قالب‌های شریک جور نیست؛ فیلدهای رکورد: ${1}";
export const FEED_BUSY_ERROR = "این منبع در حال همگام‌سازی است";
export const FEED_NOT_FOUND_ERROR = "منبع پیدا نشد";

const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const PAGE_TIMEOUT_MS = 60_000;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const OVERLAP_MS = 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const RUN_LIMIT_MS = 6 * 60 * 60 * 1000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------ the address

const SECRET_PARAM = /key|token|secret|pass|auth/i;

// the feed's address as the panel shows it: the key's value masked
export const maskFeedUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    for (const [name, value] of Array.from(url.searchParams.entries()))
      if (SECRET_PARAM.test(name)) url.searchParams.set(name, maskSecret(value));
    return decodeURI(url.toString());
  } catch {
    return "";
  }
};

const privateV4 = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const privateIp = (ip: string) => {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateV4(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
};

// an http(s) address on the internet - never this server or its network
// (the address is the admin's, but it is fetched from inside)
export const checkFeedUrl = async (raw: string) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(FEED_BAD_URL_ERROR, 400);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new AppError(FEED_BAD_URL_ERROR, 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new AppError(FEED_BAD_URL_ERROR, 400);
  const ips = net.isIP(host) ? [host] : await dns.promises.lookup(host, { all: true }).then((r) => r.map((a) => a.address)).catch(() => []);
  if (!ips.length || ips.some(privateIp)) throw new AppError(FEED_BAD_URL_ERROR, 400);
  return url;
};

// ------------------------------------------------------------ reading

// ------------------------------------------------------------ the records

// the feed's own field names for the partner file's fields (an API speaks
// English; the export file, Persian): renamed before the template looks
const ALIASES: Record<string, string[]> = {
  "نام": ["name", "full_name", "fullname", "doctor_name", "title"],
  "تخصص": ["specialty", "speciality", "specialities", "specialties", "expertise", "specialization"],
  "تلفن": ["phone", "tel", "telephone", "phone_number", "phones"],
  "معرفی پزشک": ["bio", "about", "introduction", "description", "intro"],
  "بیماری ها": ["diseases", "conditions", "disease"],
  "خدمات": ["services", "service"],
  "لوکیشن": ["location", "coordinates", "coords", "latlng", "geo", "point"],
  "آدرس": ["address", "addr"],
  "عکس": ["photo", "image", "avatar", "picture", "image_url"],
  "لینک پروفایل": ["url", "profile_url", "profile_link", "link", "source_url"],
  "نوع مرکز": ["center_type", "centre_type", "type", "kind"],
  "بیمه ها": ["insurances", "insurance", "insurers"],
  "پزشکان دارو خانه": ["pharmacists", "pharmacist", "doctors"],
};
const KNOWN = new Set([...DRDR_FIELDS, ...DRDR_PHARMACY_FIELDS]);
const aliasOf = new Map<string, string>();
for (const [fa, names] of Object.entries(ALIASES)) for (const n of names) aliasOf.set(n, fa);
const keyOf = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, "_");
// the Persian names written another way («بیماری‌ها», «بیماریها»)
const faKeyOf = (k: string) => k.replace(/[\u200c\s]+/g, "");
const faKnown = new Map(Array.from(KNOWN).map((k) => [faKeyOf(k), k]));

const known = (r: Record<string, unknown>) => Object.keys(r).filter((k) => KNOWN.has(k)).length;

// a value as the export file writes it: a list as «a، b»; a point as «lat,lng»
const flat = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    const parts = v.map((x) => (isObject(x) ? x.name ?? x.title ?? x.fa ?? "" : x)).filter((x) => typeof x === "string" || typeof x === "number");
    return parts.map(String).filter(Boolean).join("، ");
  }
  if (isObject(v)) {
    const lat = Number(v.lat ?? v.latitude);
    const lng = Number(v.lng ?? v.lon ?? v.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return `${lat},${lng}`;
    if (Array.isArray(v.coordinates) && v.coordinates.length === 2) return `${v.coordinates[1]},${v.coordinates[0]}`;
    if (typeof v.name === "string") return v.name;
    if (typeof v.title === "string") return v.title;
  }
  return v;
};

// one record in the export file's shape: unwrapped from a holder
// ({data: {...}} / {fields: {...}}), its fields under the file's names
export const normaliseRecord = (input: Record<string, unknown>): Record<string, unknown> => {
  let r = input;
  if (!known(r))
    for (const holder of ["data", "fields", "record", "attributes", "payload", "item", "doctor", "pharmacy"]) {
      const inner = r[holder];
      if (isObject(inner)) {
        r = inner;
        break;
      }
    }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    const name = KNOWN.has(k) ? k : faKnown.get(faKeyOf(k)) || aliasOf.get(keyOf(k));
    if (name && !(name in out)) out[name] = flat(v);
    else if (!name) out[k] = v;
  }
  return out;
};

// the records of one page: a partner file's groups[].items[], else the
// record list that looks most like the partner's records
const pageRecords = (page: unknown): Record<string, unknown>[] => {
  let rows: Record<string, unknown>[];
  if (isObject(page) && Array.isArray(page.groups) && page.groups.some((g) => isObject(g) && Array.isArray(g.items)))
    rows = page.groups.flatMap((g) => (isObject(g) && Array.isArray(g.items) ? g.items.filter(isObject) : []));
  else {
    const lists = findRecordLists(page).map((l) => ({ ...l, score: l.records.slice(0, 10).reduce((n, rec) => n + known(normaliseRecord(rec)), 0) }));
    rows = lists.sort((a, b) => b.score - a.score || b.records.length - a.records.length)[0]?.records || [];
  }
  return rows.map(normaliseRecord);
};

const nextOffsetOf = (page: unknown): number | null | undefined => {
  if (!isObject(page)) return undefined;
  for (const holder of [page, page.meta, page.pagination, page.paging]) {
    if (!isObject(holder) || !("next_offset" in holder || "nextOffset" in holder)) continue;
    const v = holder.next_offset ?? holder.nextOffset;
    if (v === null || v === false || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return undefined;
};

// `since` as the feed's example writes it (2026-10-01T00:00:00, UTC)
const sinceParam = (at: Date) => new Date(at.getTime() - OVERLAP_MS).toISOString().slice(0, 19);

const fetchPage = async (url: URL) => {
  await checkFeedUrl(url.toString());
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  } catch {
    throw new AppError(FEED_FETCH_ERROR, 502);
  }
  if (!res.ok) throw new AppError(FEED_FETCH_ERROR, 502);
  const text = await res.text();
  if (text.length > MAX_PAGE_BYTES) throw new AppError(FEED_FETCH_ERROR, 502);
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as unknown;
  } catch {
    throw new AppError(FEED_FETCH_ERROR, 502);
  }
};

export const readFeed = async (raw: string, since?: Date) => {
  const base = await checkFeedUrl(raw);
  const records: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(base.toString());
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    if (since) url.searchParams.set("since", sinceParam(since));
    else url.searchParams.delete("since");
    const body = await fetchPage(url);
    const rows = pageRecords(body);
    records.push(...rows);
    if (records.length > IMPORT_MAX_RECORDS) break;
    const next = nextOffsetOf(body);
    if (next === null || !rows.length) break;
    const following = next ?? (rows.length >= PAGE_SIZE ? offset + rows.length : null);
    if (following === null || following <= offset) break;
    offset = following;
  }
  return records.slice(0, IMPORT_MAX_RECORDS);
};

// ------------------------------------------------------------ one run

const running = new Set<string>();

const waitForImport = async (id: string) => {
  const until = Date.now() + RUN_LIMIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    const row = await ProviderImport.findById(id).select("status error").lean<{ status?: string; error?: string }>();
    if (!row || row.status === "failed") return row?.error || FEED_FETCH_ERROR;
    if (row.status === "done") return null;
  }
  return FEED_FETCH_ERROR;
};

const runFeed = async (feed: IProviderImportFeed, actor?: { _id: unknown; role?: string }, full = false) => {
  const id = String(feed._id);
  const startedAt = new Date();
  const finish = (lastRun: Record<string, unknown>, synced = false) =>
    ProviderImportFeed.updateOne(
      { _id: id },
      { $set: { syncing: false, lastRun: { at: startedAt, ...lastRun }, ...(synced ? { syncedUntil: startedAt } : {}) } },
    ).catch(() => undefined);
  try {
    // «همگام‌سازی کامل»: everything again, not only what changed (records
    // an older template placed wrongly are put right)
    const records = await readFeed(feed.url, full ? undefined : feed.syncedUntil);
    if (!records.length) return finish({ status: "empty", records: 0 }, true);
    // the partner file's own shape, so its template is recognised
    const root = { groups: [{ items: records }] };
    if (!detectBuiltinTemplate(root)) {
      const fields = Object.keys(records[0] || {}).slice(0, 15).join("، ");
      throw new AppError(fields ? FEED_NO_TEMPLATE_FIELDS_ERROR.replace("${1}", fields) : FEED_NO_TEMPLATE_ERROR, 400);
    }
    const stamp = startedAt.toISOString().slice(0, 16).replace("T", " ");
    const upload = await saveUpload(Buffer.from(JSON.stringify(root)), `${feed.name} (API) ${stamp}.json`, actor?._id ?? feed.createdBy);
    const template = upload.template as { name?: string; mapping?: unknown } | null;
    if (!template?.mapping) throw new AppError(FEED_NO_TEMPLATE_ERROR, 400);
    const importId = String(upload.import._id);
    await ProviderImportFeed.updateOne({ _id: id }, { $set: { "lastRun.importId": upload.import._id } });
    await startJob(importId, template.mapping, "apply", actor, { path: "/api/v1/admin/import/feeds", template: template.name });
    const error = await waitForImport(importId);
    return finish(error ? { status: "failed", records: records.length, importId: upload.import._id, error } : { status: "done", records: records.length, importId: upload.import._id }, !error);
  } catch (err) {
    console.log("[providerImportFeed] run failed:", feed.name, (err as Error)?.message || err);
    return finish({ status: "failed", error: String((err as Error)?.message || FEED_FETCH_ERROR).slice(0, 500) });
  } finally {
    running.delete(id);
  }
};

// starts a run in the background (the panel follows `syncing` / `lastRun`)
export const syncFeed = async (id: string, actor?: { _id: unknown; role?: string }, full = false) => {
  if (running.has(id)) throw new AppError(FEED_BUSY_ERROR, 409);
  const feed = await ProviderImportFeed.findOneAndUpdate({ _id: id, syncing: { $ne: true } }, { $set: { syncing: true } }, { new: true });
  if (!feed) {
    if (await ProviderImportFeed.exists({ _id: id })) throw new AppError(FEED_BUSY_ERROR, 409);
    throw new AppError(FEED_NOT_FOUND_ERROR, 404);
  }
  running.add(id);
  setImmediate(() => void runFeed(feed, actor, full));
  return feed.toObject();
};

// ------------------------------------------------------------ schedule

const due = (feed: IProviderImportFeed, now: number) =>
  !feed.lastRun?.at || now - new Date(feed.lastRun.at).getTime() >= feed.intervalHours * 60 * 60 * 1000;

const tick = async () => {
  // one import at a time (Services/providerImport.ts): a feed waits its turn
  if (running.size || (await ProviderImport.exists({ status: { $in: ["validating", "applying"] } }))) return;
  const now = Date.now();
  const feeds = await ProviderImportFeed.find({ enabled: true, intervalHours: { $gt: 0 }, syncing: { $ne: true } });
  const next = feeds.find((f) => due(f, now));
  if (next) await syncFeed(String(next._id)).catch(() => undefined);
};

let timer: NodeJS.Timeout | null = null;
export const startFeedScheduler = async () => {
  // a restart mid-run leaves a feed "syncing": its run is gone
  await ProviderImportFeed.updateMany({ syncing: true }, { $set: { syncing: false } }).catch(() => undefined);
  if (timer) return;
  timer = setInterval(() => void tick().catch((err) => console.log("[providerImportFeed] tick failed:", err)), TICK_MS);
  timer.unref?.();
};
