import mongoose, { Model } from "mongoose";
import TranslationTask from "../Models/TranslationTask";
import { Locale, SOURCE_LOCALE } from "../Lib/locales";
import { getSiteLocales } from "../Lib/siteLocales";
import { TranslatableFields, Translations } from "../Lib/i18n/translatable";
import { translatableFields } from "../Lib/i18n/translatableFields";
import { aiFeatureOpen } from "../Lib/ai/aiGate";
import { LocaleBag, machineTranslationEnabled, sourceHash, translateDocument } from "./machineTranslation";

// Automatic translation of DB content (2026-10). Every public-facing text
// model (Lib/i18n/translatableFields.ts) is translated into every enabled
// site language by the platform's AI (Lib/aiSettings.ts: Anthropic,
// OpenAI-compatible or Ollama, set in «تنظیمات سیستم ← هوش مصنوعی»):
//  - a new record, or one whose Persian text changed, is queued by the
//    translatable plugin's hooks (Lib/i18n/translatable.ts) - whichever
//    path wrote it: an admin form, an inline «create» of NodesSelector, a
//    panel, the bulk JSON import, the old-site migration;
//  - the backfill scan queues every record still missing a translation in
//    an enabled language - at boot, from the admin's button, and when the
//    super admin turns a language on;
//  - one worker drains the queue (Models/TranslationTask.ts): a record at
//    a time with a pause between calls, retries with backoff, gives up
//    after MAX_ATTEMPTS and lists the failure for the admin. The queue is
//    stored, so a restart resumes; translating a record twice is harmless
//    (only fields still missing / out of date are sent);
//  - a translation the admin wrote by hand has no machine fingerprint and
//    is never replaced (Services/machineTranslation.ts pendingFields).
// Without an AI provider the queue only fills, and the admin page says how
// many records wait.

const MAX_ATTEMPTS = 5;
// pause between two records: keeps the provider's rate limit (and the
// platform's AI budget, Lib/ai/aiGate.ts) comfortable
const GAP_MS = 1500;
const IDLE_POLL_MS = 60_000;
// a picked task is leased this long (another worker skips it)
const LEASE_MS = 10 * 60_000;
const SCAN_BATCH = 500;
const BOOT_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- models

// the translatable models that are registered (by mongoose model name)
export const translatableModels = (): { name: string; model: Model<any>; fields: TranslatableFields }[] =>
  Object.keys(translatableFields)
    .filter((name) => mongoose.modelNames().includes(name))
    .map((name) => ({ name, model: mongoose.model(name), fields: translatableFields[name] }))
    .filter(({ model }) => !!model.schema.path("translations"));

// the languages content is translated into: the enabled ones, but the one
// the content is written in
export const translationTargets = async (): Promise<Locale[]> =>
  (await getSiteLocales()).enabled.filter((l) => l !== SOURCE_LOCALE);

// the platform AI may translate: a provider is set and the AI policy has
// the feature on
export const autoTranslationReady = async () =>
  (await machineTranslationEnabled()) &&
  (await aiFeatureOpen({ audience: "admin" }, "content.translation").catch(() => false));

// ---------------------------------------------------------------- queue

const asIds = (ids: unknown[]) =>
  ids
    .map((id) => String((id as { _id?: unknown })?._id ?? id ?? ""))
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

// Adds records to the queue (a record already waiting is left as it is; one
// that failed is retried: its text has changed since).
export const enqueueTranslation = async (modelName: string, ids: unknown[], opts: { retryFailed?: boolean } = {}) => {
  if (!translatableFields[modelName]) return 0;
  const list = asIds(ids);
  if (!list.length) return 0;
  const retry = opts.retryFailed !== false;
  let added = 0;
  for (let i = 0; i < list.length; i += SCAN_BATCH) {
    const chunk = list.slice(i, i + SCAN_BATCH);
    const res = await TranslationTask.bulkWrite(
      chunk.map((doc) => ({
        updateOne: {
          filter: { model: modelName, doc },
          update: retry
            ? {
                $setOnInsert: { model: modelName, doc },
                $set: { state: "pending", attempts: 0, nextAt: new Date() },
                $unset: { lastError: 1 },
              }
            : { $setOnInsert: { model: modelName, doc, state: "pending", attempts: 0, nextAt: new Date() } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    added += res.upsertedCount || 0;
  }
  kickTranslationWorker();
  return added;
};

// for the plugin's hooks: never throws, never blocks the write
export const enqueueTranslationSoon = (modelName: string, ids: unknown[]) => {
  void enqueueTranslation(modelName, ids).catch((err) =>
    console.log("[translate] enqueue failed:", (err as Error)?.message || err),
  );
};

// ---------------------------------------------------------------- what is missing

const hasText = (value: unknown) =>
  Array.isArray(value)
    ? value.some((v) => typeof v === "string" && v.trim())
    : typeof value === "string" && value.trim() !== "";

// the languages of `targets` where `doc` still misses (or has an outdated
// machine) translation of a field with Persian text
export const missingLocales = (doc: Record<string, any>, fields: TranslatableFields, targets: readonly Locale[]) => {
  const withText = Object.keys(fields).filter((f) => hasText(doc[f]));
  if (!withText.length) return [];
  const hashes = new Map<string, string>();
  const hashOf = (f: string) => {
    if (!hashes.has(f)) hashes.set(f, sourceHash(doc[f]));
    return hashes.get(f)!;
  };
  return targets.filter((locale) => {
    const bag = ((doc.translations as Translations | undefined)?.[locale] || {}) as LocaleBag;
    return withText.some((f) => {
      if (!hasText(bag[f])) return true;
      const src = bag._src?.[f];
      return !!src && src !== hashOf(f);
    });
  });
};

export type ScanReport = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  reason?: string;
  locales: Locale[];
  // records with at least one missing language
  records: number;
  // per model: records missing each language
  missing: Record<string, Partial<Record<Locale, number>>>;
  queued: number;
  error?: string;
};

// records no page shows (not worth an AI call)
const scanFilters: Record<string, Record<string, unknown>> = {
  DoctorFaq: { archived: { $ne: true } },
};

let scan: ScanReport = { running: false, locales: [], records: 0, missing: {}, queued: 0 };
export const lastScan = () => scan;

// Walks every translatable record and queues the ones missing a
// translation in an enabled language; idempotent (a queued record stays
// queued once), safe to run again any time.
export const runTranslationBackfill = async (opts: { reason?: string; retryFailed?: boolean } = {}) => {
  if (scan.running) return scan;
  const locales = await translationTargets();
  const current: ScanReport = {
    running: true,
    startedAt: new Date().toISOString(),
    reason: opts.reason,
    locales,
    records: 0,
    missing: {},
    queued: 0,
  };
  scan = current;
  try {
    if (opts.retryFailed)
      await TranslationTask.updateMany(
        { state: "failed" },
        { $set: { state: "pending", attempts: 0, nextAt: new Date() }, $unset: { lastError: 1 } },
      );
    if (locales.length)
      for (const { name, model, fields } of translatableModels()) {
        const projection = Object.fromEntries([...Object.keys(fields), "translations"].map((f) => [f, 1]));
        const cursor = model.find(scanFilters[name] || {}, projection).lean().batchSize(SCAN_BATCH).cursor();
        let ids: unknown[] = [];
        const flush = async () => {
          if (!ids.length) return;
          current.queued += await enqueueTranslation(name, ids, { retryFailed: false });
          ids = [];
        };
        for await (const doc of cursor) {
          const missing = missingLocales(doc as Record<string, any>, fields, locales);
          if (!missing.length) continue;
          current.records++;
          const row = (current.missing[name] ||= {});
          for (const l of missing) row[l] = (row[l] || 0) + 1;
          ids.push((doc as { _id: unknown })._id);
          if (ids.length >= SCAN_BATCH) await flush();
        }
        await flush();
      }
  } catch (err) {
    current.error = String((err as Error)?.message || err).slice(0, 300);
  } finally {
    current.running = false;
    current.finishedAt = new Date().toISOString();
  }
  kickTranslationWorker();
  return current;
};

// ---------------------------------------------------------------- worker

type WorkerState = {
  running: boolean;
  paused: boolean;
  translated: number;
  written: number;
  failed: number;
  lastError?: string;
  lastAt?: string;
  // the provider is unreachable / overloaded / out of budget: the whole
  // queue waits until then (a record is not blamed for it)
  backoffUntil?: string;
};
const worker: WorkerState = { running: false, paused: false, translated: 0, written: 0, failed: 0 };
export const workerState = () => ({ ...worker });
let providerErrors = 0;

// resuming (the admin's button, new AI settings) also ends a provider
// backoff: try now
export const pauseTranslationWorker = (paused: boolean) => {
  worker.paused = paused;
  if (!paused) {
    worker.backoffUntil = undefined;
    providerErrors = 0;
    kickTranslationWorker();
  }
};

// an error of the provider (network, rate limit, overload, server error,
// the platform's AI budget) rather than of the record
const PROVIDER_ERROR =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout|aborted|socket|API (408|409|425|429|5\d\d)|Ollama (408|429|5\d\d)|not configured|سقف|فعال نیست/i;
export const isProviderError = (message: string) => PROVIDER_ERROR.test(message);
class ProviderError extends Error {}

const backoffMs = (attempts: number) => Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));

// takes the next due task (leased so another process skips it)
const claim = () =>
  TranslationTask.findOneAndUpdate(
    { state: "pending", nextAt: { $lte: new Date() } },
    { $set: { nextAt: new Date(Date.now() + LEASE_MS) } },
    { sort: { nextAt: 1, _id: 1 }, new: true },
  ).lean();

// translates one queued record; true when the queue may go on at once
export const processTranslationTask = async (
  task: { _id: unknown; model: string; doc: unknown; attempts?: number },
  locales: readonly Locale[],
) => {
  const entry = translatableModels().find((m) => m.name === task.model);
  if (!entry) {
    await TranslationTask.deleteOne({ _id: task._id });
    return;
  }
  const projection = [...Object.keys(entry.fields), "translations"];
  const doc = await entry.model.findById(task.doc, projection).lean();
  if (!doc) {
    await TranslationTask.deleteOne({ _id: task._id });
    return;
  }
  try {
    const written = await translateDocument(entry.model, doc as Record<string, any>, entry.fields, locales);
    await TranslationTask.deleteOne({ _id: task._id });
    worker.translated++;
    worker.written += written;
  } catch (err) {
    const message = String((err as Error)?.message || err).slice(0, 480);
    worker.lastError = message;
    if (isProviderError(message)) {
      // not this record's fault: it waits with the rest of the queue
      providerErrors++;
      const wait = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(5, providerErrors - 1));
      worker.backoffUntil = new Date(Date.now() + wait).toISOString();
      await TranslationTask.updateOne(
        { _id: task._id },
        { $set: { lastError: message, nextAt: new Date(Date.now() + wait) } },
      );
      throw new ProviderError(message);
    }
    const attempts = (Number(task.attempts) || 0) + 1;
    const gaveUp = attempts >= MAX_ATTEMPTS;
    await TranslationTask.updateOne(
      { _id: task._id },
      {
        $set: {
          attempts,
          lastError: message,
          state: gaveUp ? "failed" : "pending",
          nextAt: new Date(Date.now() + backoffMs(attempts)),
        },
      },
    );
    if (gaveUp) worker.failed++;
    throw err;
  }
  providerErrors = 0;
  worker.backoffUntil = undefined;
};

let wakeUp: (() => void) | null = null;
export const kickTranslationWorker = () => {
  if (wakeUp) wakeUp();
};

// one pass over the due tasks; returns how many were handled
export const drainTranslationQueue = async (opts: { limit?: number; gapMs?: number } = {}) => {
  const limit = opts.limit ?? Infinity;
  const gap = opts.gapMs ?? GAP_MS;
  let handled = 0;
  while (handled < limit && !worker.paused) {
    if (worker.backoffUntil && Date.parse(worker.backoffUntil) > Date.now()) break;
    if (!(await autoTranslationReady())) break;
    const locales = await translationTargets();
    const task = await claim();
    if (!task) break;
    if (!locales.length) {
      // no language to translate into: nothing is missing
      await TranslationTask.deleteOne({ _id: task._id });
      continue;
    }
    handled++;
    worker.lastAt = new Date().toISOString();
    const providerDown = await processTranslationTask(task, locales).then(
      () => false,
      (err) => err instanceof ProviderError,
    );
    if (providerDown) break;
    if (gap) await sleep(gap);
  }
  return handled;
};

const loop = async () => {
  for (;;) {
    worker.running = true;
    try {
      await drainTranslationQueue();
    } catch (err) {
      worker.lastError = String((err as Error)?.message || err).slice(0, 300);
    }
    worker.running = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, IDLE_POLL_MS);
      timer.unref?.();
      wakeUp = () => {
        clearTimeout(timer);
        wakeUp = null;
        resolve();
      };
    });
  }
};

let started = false;
// boot: the worker, and a backfill scan once the other boot jobs are done
export const startAutoTranslation = () => {
  if (started) return;
  started = true;
  void loop();
  const timer = setTimeout(() => {
    void runTranslationBackfill({ reason: "boot" }).catch((err) =>
      console.log("[translate] backfill failed:", (err as Error)?.message || err),
    );
  }, BOOT_DELAY_MS);
  timer.unref?.();
};

// ---------------------------------------------------------------- status

export const translationQueueStatus = async () => {
  const [pending, failed, failures, byModel] = await Promise.all([
    TranslationTask.countDocuments({ state: "pending" }),
    TranslationTask.countDocuments({ state: "failed" }),
    TranslationTask.find({ state: "failed" })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select("model doc attempts lastError updatedAt")
      .lean(),
    TranslationTask.aggregate<{ _id: string; n: number }>([
      { $group: { _id: "$model", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]),
  ]);
  return {
    ready: await autoTranslationReady(),
    locales: await translationTargets(),
    queue: { pending, failed, byModel: Object.fromEntries(byModel.map((r) => [r._id, r.n])) },
    failures,
    worker: workerState(),
    scan: lastScan(),
  };
};
