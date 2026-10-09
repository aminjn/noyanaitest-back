import { AsyncLocalStorage } from "async_hooks";
import mongoose from "mongoose";
import AppError from "./AppError";

// A centre's licence is written by one path only (2026-10, owner decision):
// the super admin's licence endpoint (Controllers/adminCentreLicenceController.ts,
// PUT /admin/<kind>/<id>/licence) and the controlled copy a become-request's
// approval makes (Controllers/adminEntityController.ts approveBecome). The
// licence number field of each kind (Clinic.clinicCode, Hospital.code,
// Pharmacy / ParaClinic / Insurance licenseNumber) and the whole `licence`
// sub-document are locked at the schema: a save, create, insertMany or
// update that changes them is refused unless it runs inside
// withCentreLicenceWrite(). The generic /auto/<model> create / edit, the
// centres' own profile forms and any future writer get the refusal, not a
// silent overwrite of the verified tick (Lib/centreVerified.ts).
//
// A write that sends the same values the record already holds (an admin
// form that posts the whole record back) passes: only a CHANGE is refused.
// Migrations write through the raw collection (Model.collection), which has
// no middleware.

const licenceWriteScope = new AsyncLocalStorage<boolean>();

// runs fn as an authorised licence writer (the licence endpoint, the
// approval's copy). fn may return a mongoose Query: it is awaited inside
// the scope (a Query only runs when awaited, so returning it would run it
// outside)
export const withCentreLicenceWrite = <T>(fn: () => PromiseLike<T>): Promise<T> =>
  licenceWriteScope.run(true, async () => await fn());

const licenceWriteAllowed = () => licenceWriteScope.getStore() === true;

export const centreLicenceLockedMessage =
  "شماره و تاریخ‌های پروانه‌ی مرکز فقط از بخش «پروانه‌ی فعالیت و نشان تأیید» صفحه‌ی مرکز در پنل مدیریت تغییر می‌کند";

const lockedError = () => new AppError(centreLicenceLockedMessage, 403);

const LICENCE_KEYS = ["verifiedAt", "verifiedBy", "issuedAt", "expiresAt"] as const;

const normValue = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : String(v.getTime());
  if (v instanceof mongoose.Types.ObjectId) return String(v);
  if (typeof v === "object" && v && "_id" in (v as object)) return String((v as { _id: unknown })._id);
  if (typeof v === "string") {
    const s = v.trim();
    // a date sent as a string compares by its instant
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      const t = new Date(s).getTime();
      if (!Number.isNaN(t)) return String(t);
    }
    return s;
  }
  return String(v);
};

const plain = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object") return {};
  const o = v as { toObject?: () => Record<string, unknown> };
  return typeof o.toObject === "function" ? o.toObject() : (v as Record<string, unknown>);
};

const normLicence = (v: unknown) => {
  const o = plain(v);
  return LICENCE_KEYS.map((k) => normValue(o[k])).join("|");
};

// the locked part of a record, as one comparable string
const snapshotOf = (numberField: string, doc: Record<string, unknown> | null | undefined) =>
  `${normValue(doc?.[numberField])}#${normLicence(doc?.licence)}`;

const isLockedKey = (numberField: string, key: string) =>
  key === numberField || key === "licence" || key.startsWith("licence.");

// a record with an update's locked values applied on top (enough to
// compare: only the locked paths are read)
const applyLocked = (
  numberField: string,
  current: Record<string, unknown>,
  sets: Record<string, unknown>,
  unsets: string[],
) => {
  const next: Record<string, unknown> = {
    [numberField]: current[numberField],
    licence: { ...plain(current.licence) },
  };
  const lic = next.licence as Record<string, unknown>;
  for (const key of unsets) {
    if (key === numberField) next[numberField] = undefined;
    else if (key === "licence") next.licence = {};
    else (next.licence as Record<string, unknown>)[key.slice("licence.".length)] = undefined;
  }
  for (const [key, value] of Object.entries(sets)) {
    if (key === numberField) next[numberField] = value;
    else if (key === "licence") next.licence = plain(value);
    else lic[key.slice("licence.".length)] = value;
  }
  return next;
};

type Split = { sets: Record<string, unknown>; unsets: string[]; other: boolean };

// the locked paths an update writes; `other`: an operator that can't be
// compared ($inc, $push, $rename ... on a locked path)
const lockedOfUpdate = (numberField: string, update: Record<string, unknown>, replace: boolean): Split => {
  const out: Split = { sets: {}, unsets: [], other: false };
  if (!update || typeof update !== "object") return out;
  if (replace) {
    // a replacement document: what it lacks is removed
    out.sets[numberField] = update[numberField];
    out.sets.licence = update.licence;
    return out;
  }
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith("$")) {
      if (isLockedKey(numberField, key)) out.sets[key] = value;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [path, v] of Object.entries(value as Record<string, unknown>)) {
      const touches = isLockedKey(numberField, path) || (key === "$rename" && typeof v === "string" && isLockedKey(numberField, v));
      if (!touches) continue;
      if (key === "$set" || key === "$setOnInsert") out.sets[path] = v;
      else if (key === "$unset") out.unsets.push(path);
      else out.other = true;
    }
  }
  return out;
};

const touchesLocked = (s: Split) => s.other || s.unsets.length > 0 || Object.keys(s.sets).length > 0;

// Adds the lock to a centre schema. numberField: the kind's licence number
// field (Lib/centreVerified.ts centreLicenceNumberField).
export const centreLicenceLockPlugin = (schema: mongoose.Schema, opts: { numberField: string }) => {
  const { numberField } = opts;

  // what the record held when it was read
  schema.post("init", function (this: mongoose.Document) {
    this.$locals.licenceSnapshot = snapshotOf(numberField, this as unknown as Record<string, unknown>);
  });

  schema.pre("save", function (this: mongoose.Document, next) {
    if (licenceWriteAllowed()) return next();
    const before = this.isNew ? snapshotOf(numberField, null) : (this.$locals.licenceSnapshot as string | undefined) ?? snapshotOf(numberField, null);
    const now = snapshotOf(numberField, this as unknown as Record<string, unknown>);
    if (before !== now) return next(lockedError());
    next();
  });

  schema.post("save", function (this: mongoose.Document) {
    this.$locals.licenceSnapshot = snapshotOf(numberField, this as unknown as Record<string, unknown>);
  });

  schema.pre("insertMany", function (next: (err?: Error) => void, docs: unknown) {
    if (licenceWriteAllowed()) return next();
    const list = Array.isArray(docs) ? docs : [docs];
    const empty = snapshotOf(numberField, null);
    for (const d of list) if (snapshotOf(numberField, plain(d)) !== empty) return next(lockedError());
    next();
  });

  const guardQuery = (replace: boolean) =>
    async function (this: mongoose.Query<unknown, unknown>) {
      if (licenceWriteAllowed()) return;
      const update = this.getUpdate() as Record<string, unknown> | null;
      const split = lockedOfUpdate(numberField, update || {}, replace);
      if (!touchesLocked(split)) return;
      if (split.other) throw lockedError();
      const many = (this as unknown as { op?: string }).op === "updateMany";
      const rows = (await this.model
        .find(this.getFilter())
        .select([numberField, "licence"])
        .limit(many ? 0 : 1)
        .lean()) as Record<string, unknown>[];
      // an upsert that makes a new record starts with no licence
      const targets = rows.length ? rows : this.getOptions().upsert ? [{}] : [];
      for (const row of targets) {
        const after = applyLocked(numberField, row, split.sets, split.unsets);
        if (snapshotOf(numberField, after) !== snapshotOf(numberField, row)) throw lockedError();
      }
    };

  schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], { query: true, document: false }, guardQuery(false));
  schema.pre(["replaceOne", "findOneAndReplace"], { query: true, document: false }, guardQuery(true));
};
