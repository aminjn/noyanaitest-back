import mongoose, { Model, Types } from "mongoose";
import Speciality from "../Models/Speciality";
import Disease from "../Models/Disease";
import ServiceCategory from "../Models/ServiceCategory";
import DoctorProfile from "../Models/DoctorProfile";
import Doctor from "../Models/Doctor";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import InsuranceTariff from "../Models/InsuranceTariff";
import Service from "../Models/Service";
import ServicePackage from "../Models/ServicePackage";
import CatalogSuggestion from "../Models/CatalogSuggestion";
import CatalogMerge from "../Models/CatalogMerge";
import { buildMatcher, CatalogKind, findDuplicates, keyOf, Matcher, matchName, MatchRow } from "../Lib/catalog/catalogMatch";
import { CANONICAL_SPECIALITIES, CANONICAL_VERSION } from "../Lib/catalog/specialityCanonical";
import { matchKey } from "../Lib/providerImport/textExtract";
import crypto from "crypto";
import slugify from "../Lib/slug";

// The catalogue clean-up (2026-10, after a partner import turned every
// free-text «تخصص» into a new speciality): the admin's «ادغام و پاک‌سازی»
// tab and the provider import share it.
//  - merge: every reference (doctors, legacy doctors, requests, tariffs,
//    conditions, services) moves to the target, the merged entries are
//    archived (inactive, out of every list, their URL redirects to the
//    target) and their names become the target's synonyms - so the next
//    import matches them. Logged in CatalogMerge and undone from it.
//  - the canonical speciality list (Lib/catalog/specialityCanonical.ts) is
//    seeded over the existing entries: a matching one becomes canonical.
//  - a name an import cannot match waits in CatalogSuggestion; nothing is
//    created from free text.

type Ref = { model: Model<any>; field: string; array: boolean };

const kindModel: Record<CatalogKind, Model<any>> = {
  speciality: Speciality,
  disease: Disease,
  service: ServiceCategory,
};

export const nameField = (kind: CatalogKind) => (kind === "service" ? "title" : "name");
const activeField = (kind: CatalogKind) => (kind === "service" ? "isActive" : kind === "disease" ? "published" : "active");

const refsOf: Record<CatalogKind, Ref[]> = {
  speciality: [
    { model: DoctorProfile, field: "mainSpeciality", array: false },
    { model: DoctorProfile, field: "specialities", array: true },
    { model: Doctor, field: "speciality", array: false },
    { model: Doctor, field: "specialities", array: true },
    { model: BecomeDoctorRequest, field: "specialities", array: true },
    { model: InsuranceTariff, field: "speciality", array: false },
    { model: Disease, field: "specialities", array: true },
    { model: Speciality, field: "parent", array: false },
  ],
  disease: [
    { model: DoctorProfile, field: "diseases", array: true },
    { model: Disease, field: "sameAs", array: true },
  ],
  service: [
    { model: DoctorProfile, field: "serviceCategories", array: true },
    { model: Service, field: "category", array: false },
    { model: ServicePackage, field: "category", array: false },
  ],
};

const uniqueSlug = async (model: Model<any>, base: string) => {
  const root = slugify(base) || `c-${crypto.randomBytes(3).toString("hex")}`;
  let slug = root;
  let n = 2;
  while (await model.exists({ slug })) slug = `${root}-${n++}`;
  return slug;
};

// ------------------------------------------------------------ the rows

// doctors per entry (every doctor profile, active or not: a merge moves them all)
const doctorCounts = async (kind: CatalogKind) => {
  const field = kind === "speciality" ? "specialities" : kind === "disease" ? "diseases" : "serviceCategories";
  const rows = await DoctorProfile.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $unwind: `$${field}` },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

export const catalogRows = async (kind: CatalogKind): Promise<MatchRow[]> => {
  const name = nameField(kind);
  const [docs, counts] = await Promise.all([
    kindModel[kind]
      .find({})
      .select(`${name} synonyms translations canonical tier archived mergedInto ${activeField(kind)} slug`)
      .lean<Record<string, any>[]>(),
    doctorCounts(kind),
  ]);
  return docs.map((d) => {
    const translated = Object.values((d.translations || {}) as Record<string, Record<string, unknown>>)
      .map((t) => t?.[name])
      .filter((v): v is string => typeof v === "string" && !!v.trim());
    return {
      id: String(d._id),
      name: d[name] || "",
      aliases: [...(Array.isArray(d.synonyms) ? d.synonyms : []), ...translated],
      canonical: !!d.canonical,
      active: !!d[activeField(kind)],
      archived: !!d.archived,
      mergedInto: d.mergedInto ? String(d.mergedInto) : undefined,
      tier: d.tier,
      doctors: counts.get(String(d._id)) || 0,
      slug: d.slug,
    } as MatchRow & { slug?: string };
  });
};

export const loadMatcher = async (kind: CatalogKind): Promise<Matcher> => buildMatcher(kind, await catalogRows(kind));

// ------------------------------------------------------------ duplicates

export const duplicateGroups = async (kind: CatalogKind) => findDuplicates(await loadMatcher(kind));

// ------------------------------------------------------------ merge

export class CatalogMergeError extends Error {}

const toIds = (ids: unknown[]) =>
  [...new Set(ids.map(String))].filter((id) => mongoose.isValidObjectId(id)).map((id) => new Types.ObjectId(id));

export const mergeEntries = async (kind: CatalogKind, targetId: string, sourceIds: string[], by?: unknown) => {
  const model = kindModel[kind];
  const name = nameField(kind);
  const target = await model.findById(targetId);
  if (!target || target.archived) throw new CatalogMergeError("مقصد ادغام پیدا نشد");
  const sources = toIds(sourceIds).filter((id) => !id.equals(target._id));
  if (!sources.length) throw new CatalogMergeError("موردی برای ادغام انتخاب نشده است");
  const docs = await model.find({ _id: { $in: sources }, archived: { $ne: true } });
  if (!docs.length) throw new CatalogMergeError("موردی برای ادغام انتخاب نشده است");
  const ids = docs.map((d) => d._id as Types.ObjectId);

  // every reference to a source moves to the target; the log keeps which
  // records held which source, to undo the merge
  const moved: { model: string; field: string; doc: Types.ObjectId; from: Types.ObjectId }[] = [];
  for (const ref of refsOf[kind]) {
    const holders = await ref.model
      .find({ [ref.field]: { $in: ids } })
      .select(`_id ${ref.field}`)
      .lean<Record<string, any>[]>();
    for (const h of holders) {
      const value = h[ref.field];
      const from = (ref.array ? (Array.isArray(value) ? value : []) : [value]).filter((v: unknown) => ids.some((i) => i.equals(v as Types.ObjectId)));
      for (const f of from) moved.push({ model: ref.model.modelName, field: ref.field, doc: h._id, from: f });
    }
    if (!holders.length) continue;
    const holderIds = holders.map((h) => h._id);
    if (ref.array) {
      // add the target once, then take the sources out
      await ref.model.updateMany({ _id: { $in: holderIds } }, { $addToSet: { [ref.field]: target._id } });
      await ref.model.updateMany({ _id: { $in: holderIds } }, { $pull: { [ref.field]: { $in: ids } } });
      // an entry never lists itself (a condition's «sameAs», a parent)
      await ref.model.updateMany({ _id: target._id }, { $pull: { [ref.field]: target._id } });
    } else {
      await ref.model.updateMany({ [ref.field]: { $in: ids } }, { $set: { [ref.field]: target._id } });
      if (ref.model === model) await model.updateOne({ _id: target._id, [ref.field]: target._id }, { $unset: { [ref.field]: 1 } });
    }
  }

  // the merged names (and theirs) become the target's synonyms
  const targetKey = keyOf(kind, target[name]);
  const names = new Set<string>(Array.isArray(target.synonyms) ? target.synonyms : []);
  for (const d of docs) {
    for (const n of [d[name], ...(Array.isArray(d.synonyms) ? d.synonyms : [])])
      if (typeof n === "string" && n.trim() && keyOf(kind, n) !== targetKey) names.add(n.trim());
  }
  const before = {
    synonyms: Array.isArray(target.synonyms) ? [...target.synonyms] : [],
    states: docs.map((d) => ({ id: d._id, active: !!d[activeField(kind)], mergedInto: d.mergedInto || null })),
  };
  await model.updateOne({ _id: target._id }, { $set: { synonyms: [...names].slice(0, 200) } });
  await model.updateMany(
    { _id: { $in: ids } },
    { $set: { archived: true, archivedAt: new Date(), mergedInto: target._id, [activeField(kind)]: false } },
  );
  // what was merged into a source earlier now leads to the target
  await model.updateMany({ mergedInto: { $in: ids } }, { $set: { mergedInto: target._id } });
  // the suggestions the sources answered now point at the target
  await CatalogSuggestion.updateMany({ kind, target: { $in: ids } }, { $set: { target: target._id } });

  const log = await CatalogMerge.create({
    kind,
    target: target._id,
    sources: ids,
    moved,
    before,
    by: by && mongoose.isValidObjectId(String(by)) ? new Types.ObjectId(String(by)) : undefined,
  });
  return { merge: log._id, merged: ids.length, moved: moved.length };
};

const UNDO_DAYS = 30;

export const undoMerge = async (mergeId: string) => {
  const log = await CatalogMerge.findById(mergeId);
  if (!log || log.undoneAt) throw new CatalogMergeError("این ادغام پیدا نشد یا قبلاً برگردانده شده است");
  if (Date.now() - new Date(log.createdAt).getTime() > UNDO_DAYS * 86400000)
    throw new CatalogMergeError("مهلت برگرداندن این ادغام (۳۰ روز) گذشته است");
  const kind = log.kind as CatalogKind;
  const model = kindModel[kind];
  for (const s of log.before?.states || [])
    await model.updateOne(
      { _id: s.id },
      { $set: { archived: false, [activeField(kind)]: !!s.active, ...(s.mergedInto ? { mergedInto: s.mergedInto } : {}) }, $unset: { archivedAt: 1, ...(s.mergedInto ? {} : { mergedInto: 1 }) } },
    );
  await model.updateOne({ _id: log.target }, { $set: { synonyms: log.before?.synonyms || [] } });
  // each record gets its source back; the target stays only where it was
  // already listed before the merge (an array that had both)
  const byModel = new Map<string, Model<any>>(refsOf[kind].map((r) => [r.model.modelName, r.model]));
  const arrays = new Set(refsOf[kind].filter((r) => r.array).map((r) => `${r.model.modelName}.${r.field}`));
  for (const m of log.moved || []) {
    const ref = byModel.get(m.model);
    if (!ref) continue;
    if (arrays.has(`${m.model}.${m.field}`)) await ref.updateOne({ _id: m.doc }, { $addToSet: { [m.field]: m.from } });
    else await ref.updateOne({ _id: m.doc, [m.field]: log.target }, { $set: { [m.field]: m.from } });
  }
  log.undoneAt = new Date();
  await log.save();
  return { restored: (log.sources || []).length };
};

// ------------------------------------------------------------ unused entries

// the entries no doctor, service or condition uses and nobody approved:
// archived (not deleted) in one go - the bulk of a bad import
export const archiveUnused = async (kind: CatalogKind, dry = false) => {
  const rows = await catalogRows(kind);
  const candidates = rows.filter((r) => !r.archived && !r.canonical && !r.doctors);
  const ids: Types.ObjectId[] = [];
  for (const r of candidates) {
    const id = new Types.ObjectId(r.id);
    let used = false;
    for (const ref of refsOf[kind]) {
      if (ref.model === DoctorProfile) continue;
      if (await ref.model.exists({ [ref.field]: id })) {
        used = true;
        break;
      }
    }
    // a condition with a written page stays (its content is the value)
    if (!used && kind === "disease") used = !!(await Disease.exists({ _id: id, published: true }));
    if (!used) ids.push(id);
  }
  if (!dry && ids.length)
    await kindModel[kind].updateMany({ _id: { $in: ids } }, { $set: { archived: true, archivedAt: new Date(), [activeField(kind)]: false } });
  return { archived: ids.length };
};

// ------------------------------------------------------------ the canonical list

// Every canonical speciality: an existing entry with the same name (or a
// synonym) becomes the canonical one - its slug, doctors and page stay;
// the rest are created. Nothing is deleted; run again, nothing changes.
export const seedCanonicalSpecialities = async () => {
  let matched = 0;
  let created = 0;
  const idByFa = new Map<string, Types.ObjectId>();
  for (const c of CANONICAL_SPECIALITIES) {
    const m = buildMatcher("speciality", await catalogRows("speciality"));
    const keys = [c.fa, ...(c.syn || [])].map((n) => keyOf("speciality", n));
    let hit: MatchRow | undefined;
    for (const n of [c.fa, ...(c.syn || [])]) {
      const r = matchName(m, n);
      if (r.status === "exact") {
        hit = r.row;
        break;
      }
    }
    // never take an entry another canonical one already owns
    if (hit && hit.canonical && keyOf("speciality", hit.name) !== keys[0]) hit = undefined;
    const set = {
      canonical: true,
      canonicalVersion: CANONICAL_VERSION,
      tier: c.tier,
      level: c.tier === "general" ? "general" : c.tier === "specialty" ? "specialist" : c.tier === "allied" ? undefined : "subspecialist",
      "translations.en.name": c.en,
    };
    let id: Types.ObjectId;
    if (hit) {
      id = new Types.ObjectId(hit.id);
      const doc = await Speciality.findById(id).select("synonyms name").lean<{ synonyms?: string[]; name: string }>();
      const syn = new Set(doc?.synonyms || []);
      for (const s of c.syn || []) syn.add(s);
      if (doc && keyOf("speciality", doc.name) !== keys[0]) syn.add(doc.name);
      await Speciality.updateOne(
        { _id: id },
        { $set: { ...set, name: c.fa, active: true, archived: false, synonyms: [...syn] }, $unset: { mergedInto: 1, archivedAt: 1 } },
      );
      matched++;
    } else {
      const sp = await Speciality.create({ name: c.fa, active: true, slug: await uniqueSlug(Speciality, c.en || c.fa), synonyms: c.syn || [], ...set });
      id = sp._id as Types.ObjectId;
      created++;
    }
    idByFa.set(matchKey(c.fa), id);
  }
  for (const c of CANONICAL_SPECIALITIES)
    if (c.parent) {
      const id = idByFa.get(matchKey(c.fa));
      const parent = idByFa.get(matchKey(c.parent));
      if (id && parent && !id.equals(parent)) await Speciality.updateOne({ _id: id }, { $set: { parent } });
    }
  return { matched, created, total: CANONICAL_SPECIALITIES.length };
};

// ------------------------------------------------------------ suggestions

// a name an import could not place: one record per kind + key, with the
// doctors who wrote it (so mapping it later fixes them too)
export const suggestName = async (
  kind: CatalogKind,
  raw: string,
  opts: { doctor?: Types.ObjectId; draft?: boolean; hint?: MatchRow; importId?: Types.ObjectId } = {},
) => {
  const key = keyOf(kind, raw);
  if (key.length < 2) return;
  await CatalogSuggestion.updateOne(
    { kind, key },
    {
      $setOnInsert: { raw: raw.trim(), status: "pending" },
      $addToSet: {
        variants: raw.trim(),
        ...(opts.doctor ? { doctors: opts.doctor } : {}),
        ...(opts.doctor && opts.draft ? { drafts: opts.doctor } : {}),
      },
      ...(opts.hint || opts.importId
        ? {
            $set: {
              ...(opts.hint ? { hint: new Types.ObjectId(opts.hint.id), hintName: opts.hint.name } : {}),
              ...(opts.importId ? { lastImport: opts.importId } : {}),
            },
          }
        : {}),
    },
    { upsert: true },
  );
  await CatalogSuggestion.updateOne({ kind, key }, [{ $set: { doctorCount: { $size: "$doctors" } } }]);
};

const listField: Record<CatalogKind, string> = { speciality: "specialities", disease: "diseases", service: "serviceCategories" };

// the admin's answer to a suggestion: map it to an entry (the name becomes
// its synonym and the doctors who wrote it get it), create it, or reject it
export const resolveSuggestion = async (id: string, action: "map" | "create" | "reject", targetId?: string, by?: unknown) => {
  const s = await CatalogSuggestion.findById(id);
  if (!s || s.status !== "pending") throw new CatalogMergeError("این پیشنهاد پیدا نشد یا قبلاً بررسی شده است");
  const kind = s.kind as CatalogKind;
  const model = kindModel[kind];
  let target: Types.ObjectId | undefined;
  if (action === "map") {
    const t = targetId && mongoose.isValidObjectId(targetId) ? await model.findById(targetId) : null;
    if (!t || t.archived) throw new CatalogMergeError("مقصد ادغام پیدا نشد");
    target = t._id as Types.ObjectId;
    const syn = new Set<string>(Array.isArray(t.synonyms) ? t.synonyms : []);
    for (const v of [s.raw, ...(s.variants || [])]) if (keyOf(kind, v) !== keyOf(kind, t[nameField(kind)])) syn.add(v);
    await model.updateOne({ _id: target }, { $set: { synonyms: [...syn].slice(0, 200) } });
  } else if (action === "create") {
    const field = nameField(kind);
    const doc = await model.create({
      [field]: s.raw,
      [activeField(kind)]: kind !== "disease",
      slug: await uniqueSlug(model, s.raw),
      synonyms: (s.variants || []).filter((v) => v !== s.raw),
    });
    target = doc._id as Types.ObjectId;
  }
  if (target && s.doctors?.length) {
    await DoctorProfile.updateMany({ _id: { $in: s.doctors } }, { $addToSet: { [listField[kind]]: target } });
    if (kind === "speciality")
      await DoctorProfile.updateMany({ _id: { $in: s.doctors }, mainSpeciality: { $exists: false } }, { $set: { mainSpeciality: target } });
  }
  s.status = action === "map" ? "mapped" : action === "create" ? "created" : "rejected";
  if (target) s.target = target;
  s.resolvedAt = new Date();
  if (by && mongoose.isValidObjectId(String(by))) s.resolvedBy = new Types.ObjectId(String(by));
  await s.save();
  return { status: s.status, target };
};
