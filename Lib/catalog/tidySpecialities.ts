import { Types } from "mongoose";
import DoctorProfile from "../../Models/DoctorProfile";
import ServiceCategory from "../../Models/ServiceCategory";
import { catalogRows, mergeEntries, seedCanonicalSpecialities } from "../../Services/catalogCleanup";
import { keyOf, MatchRow } from "./catalogMatch";
import { CANONICAL_FELLOWSHIPS, PROCEDURE_SPECIALITIES, SPECIALITY_MERGES } from "./specialityCanonical";
import { matchKey } from "../providerImport/textExtract";
import slugify from "../slug";

// The speciality directory's tidy-up (2026-10, owner review: «many of these
// are not specialities»). Like Doctolib and Paziresh24 the list holds real
// fields only. Run by the admin from «ادغام و پاک‌سازی» (a preview first):
//  1. the canonical list is seeded (Lib/catalog/specialityCanonical.ts);
//  2. a procedure filed as a speciality (laparoscopy, echocardiography...)
//     becomes a service: its doctors get the service and move to the
//     parent speciality, the old entry is merged there (its URL redirects);
//  3. another wording of a canonical field, or a name that is no field
//     («پزشکی», an academic degree), is merged into the right entry;
//  4. every entry whose name (or synonym) is exactly a canonical one is
//     merged into it - the import's leftovers the seed did not take.
// Every merge goes through mergeEntries: logged and undoable for 30 days.

export type TidyStep = { kind: "procedure" | "fellowship" | "merge" | "duplicate"; target: string; sources: string[]; service?: string };

const uniqueSlug = async (base: string) => {
  const root = slugify(base) || `s-${new Types.ObjectId().toString().slice(-6)}`;
  let slug = root;
  let n = 2;
  while (await ServiceCategory.exists({ slug })) slug = `${root}-${n++}`;
  return slug;
};

const serviceFor = async (title: string, en: string) => {
  const key = matchKey(title);
  const rows = await ServiceCategory.find({ archived: { $ne: true } })
    .select("title synonyms")
    .lean<{ _id: Types.ObjectId; title?: string; synonyms?: string[] }[]>();
  const hit = rows.find((r) => [r.title, ...(r.synonyms || [])].some((n) => matchKey(n) === key));
  if (hit) return hit._id;
  const created = await ServiceCategory.create({ title, isActive: true, slug: await uniqueSlug(en || title), "translations.en.title": en });
  return created._id as Types.ObjectId;
};

const live = async () => (await catalogRows("speciality")).filter((r) => !r.archived);
const canonicalNamed = (rows: MatchRow[], fa: string) => rows.find((r) => r.canonical && matchKey(r.name) === matchKey(fa));

// what the tidy-up would do on the current catalogue, without doing it;
// `apply` runs each step on the rows as they are at that moment
export const tidySpecialities = async (apply: boolean) => {
  if (apply) await seedCanonicalSpecialities();
  const steps: TidyStep[] = [];
  const nameOf = (rows: MatchRow[], ids: string[]) => ids.map((id) => rows.find((r) => r.id === id)?.name || id);
  const taken = new Set<string>();

  // 2. procedures -> services
  for (const p of PROCEDURE_SPECIALITIES) {
    const rows = await live();
    const parent = canonicalNamed(rows, p.parent);
    if (!parent) continue;
    const keys = new Set([p.fa, ...(p.syn || [])].map((n) => keyOf("speciality", n)).filter(Boolean));
    const hits = rows.filter((r) => r.id !== parent.id && !taken.has(r.id) && keys.has(keyOf("speciality", r.name)));
    if (!hits.length) continue;
    const ids = hits.map((h) => h.id);
    ids.forEach((id) => taken.add(id));
    steps.push({ kind: "procedure", target: parent.name, sources: nameOf(rows, ids), service: p.service });
    if (!apply) continue;
    const service = await serviceFor(p.service, p.serviceEn);
    await DoctorProfile.updateMany(
      { specialities: { $in: ids.map((id) => new Types.ObjectId(id)) } },
      { $addToSet: { serviceCategories: service } },
    );
    await mergeEntries("speciality", parent.id, ids).catch((err) => console.log("[specialities] procedure merge failed:", p.fa, err));
  }

  // 2b. a fellowship is not a speciality: its entry (an import's, or the
  // first version of the official list's) merges into its parent field
  for (const f of CANONICAL_FELLOWSHIPS) {
    if (!f.parent) continue;
    const rows = await live();
    const parent = canonicalNamed(rows, f.parent);
    if (!parent) continue;
    const keys = new Set([f.fa, ...(f.syn || [])].map((n) => keyOf("speciality", n)).filter(Boolean));
    const hits = rows.filter(
      (r) =>
        r.id !== parent.id &&
        !taken.has(r.id) &&
        !(r.canonical && r.tier && r.tier !== "fellowship") &&
        keys.has(keyOf("speciality", r.name)),
    );
    if (!hits.length) continue;
    const ids = hits.map((h) => h.id);
    ids.forEach((id) => taken.add(id));
    steps.push({ kind: "fellowship", target: parent.name, sources: nameOf(rows, ids) });
    if (apply) await mergeEntries("speciality", parent.id, ids).catch((err) => console.log("[specialities] fellowship merge failed:", f.fa, err));
  }

  // 3. other wordings and non-fields
  for (const m of SPECIALITY_MERGES) {
    const rows = await live();
    const target = canonicalNamed(rows, m.into);
    const from = matchKey(m.from);
    if (!target || !from) continue;
    const hits = rows.filter((r) => {
      if (r.id === target.id || r.canonical || taken.has(r.id)) return false;
      const k = matchKey(r.name);
      return m.exact ? k === from : k.startsWith(from);
    });
    if (!hits.length) continue;
    const ids = hits.map((h) => h.id);
    ids.forEach((id) => taken.add(id));
    steps.push({ kind: "merge", target: target.name, sources: nameOf(rows, ids) });
    if (apply) await mergeEntries("speciality", target.id, ids).catch((err) => console.log("[specialities] merge failed:", m.from, err));
  }

  // 4. exact duplicates of a canonical entry
  const rows = await live();
  const canonicalByKey = new Map<string, MatchRow>();
  for (const r of rows)
    if (r.canonical)
      for (const n of [r.name, ...(r.aliases || [])]) {
        const k = keyOf("speciality", n);
        if (k && !canonicalByKey.has(k)) canonicalByKey.set(k, r);
      }
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (r.canonical || taken.has(r.id)) continue;
    const target = canonicalByKey.get(keyOf("speciality", r.name));
    if (target) groups.set(target.id, [...(groups.get(target.id) || []), r.id]);
  }
  for (const [target, ids] of Array.from(groups.entries())) {
    steps.push({ kind: "duplicate", target: rows.find((r) => r.id === target)?.name || target, sources: nameOf(rows, ids) });
    if (apply) await mergeEntries("speciality", target, ids).catch((err) => console.log("[specialities] duplicate merge failed:", err));
  }
  return { steps, entries: steps.reduce((n, s) => n + s.sources.length, 0) };
};
