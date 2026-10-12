import { z } from "zod";
import {
  AnyKind,
  ChildKind,
  ImportKind,
  importKinds,
  childKinds,
  kindChildren,
  kindFields,
  kindSynonyms,
  nativeListKeys,
  TargetField,
} from "./catalog";
import { analyseRecords, findRecordLists, nameKey, readPath, recordsAt, SourceList, SourcePath } from "./source";
import crypto from "crypto";
import { idFromUrl, matchKey, unwrapImageUrl } from "./textExtract";

// Bulk provider import: the admin's field mapping (2026-10). A mapping says,
// for each record list of the source file the admin picked, which profile
// type it is and how each of our fields is read from a source record:
//
//   { version: 1, lists: [ { path: "data.items", kind: "doctor",
//       fields: { firstName: { source: "fullname", split: { by: " ", index: 0 } },
//                 medicalCode: { source: "nezam", transforms: ["digits"] },
//                 gender: { source: "sex", valueMap: { "M": "male" } },
//                 "firstName@en": { source: "name_en" } },
//       children: [ { path: "clinics", kind: "office",
//           fields: { address: { source: "addr" }, point: { source: "geo" } },
//           children: [ { path: "times", kind: "hours", fields: { ... } } ] } ] } ] }
//
// A rule reads one path (`source`), several joined (`sources` + `join`), or
// a constant; then optionally splits a text, runs simple transforms and
// a value map. `<field>@<locale>` fills a translation. The same engine runs
// for the live preview and on the server for the real run: the file never
// has to be mapped in the browser. Our documented format maps 1:1
// (nativeMapping).

export const ruleTransforms = ["trim", "digits", "phone", "rialToToman", "tomanToRial", "lower", "stripTitle", "number"] as const;
export type RuleTransform = (typeof ruleTransforms)[number];
const TEXT_TRANSFORMS: readonly RuleTransform[] = ["trim", "digits", "lower", "stripTitle"];
const VALUE_TRANSFORMS: readonly RuleTransform[] = ["phone", "number", "rialToToman", "tomanToRial"];

const pathText = z.string().max(300);

// how a value is read (Lib/providerImport/textExtract.ts): the id in a
// link, the file behind an image proxy link, names joined by spaces, or a
// stable id hashed from the record's own fields (a source with no id:
// `sources` [name, phone] -> "<hash>"). Free text is never mined.
export const ruleExtracts = ["urlId", "imageUrl", "joinedList", "hashId"] as const;
export type RuleExtract = (typeof ruleExtracts)[number];

export const ruleSchema = z
  .object({
    source: pathText.optional(),
    sources: z.array(pathText).max(10).optional(),
    join: z.string().max(10).optional(),
    constant: z
      .union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(300)).max(100)])
      .optional(),
    split: z
      .object({
        by: z.string().min(1).max(10),
        // which part; negative counts from the end; none = every part (a list)
        index: z.number().int().min(-20).max(20).optional(),
        // the parts from `index` on, joined back with a space
        rest: z.boolean().optional(),
      })
      .optional(),
    transforms: z.array(z.enum(ruleTransforms)).max(10).optional(),
    valueMap: z.record(z.string().max(300), z.string().max(300)).optional(),
    extract: z.enum(ruleExtracts).optional(),
    // put before the value (an id namespace: "drdr:")
    prefix: z.string().max(40).optional(),
  })
  .strict();
export type MappingRule = z.infer<typeof ruleSchema>;

export type ListMapping = {
  path: string;
  kind: AnyKind;
  fields: Record<string, MappingRule>;
  children?: ListMapping[];
};

const fieldKey = z.string().regex(/^[A-Za-z]+(@[a-z]{2})?$/).max(40);

export const listMappingSchema: z.ZodType<ListMapping> = z.lazy(() =>
  z
    .object({
      path: z.string().max(300),
      kind: z.enum([...importKinds, ...childKinds] as [AnyKind, ...AnyKind[]]),
      fields: z.record(fieldKey, ruleSchema),
      children: z.array(listMappingSchema).max(10).optional(),
    })
    .strict(),
);

// how a file is read beyond its field rules (a built-in template carries
// these)
export const mappingOptionsSchema = z
  .object({
    // a name of a speciality, condition or service missing from the
    // catalogue is added to it at once (conditions as unpublished drafts),
    // with no value-map step: the built-in partner templates
    autoCreate: z.boolean().optional(),
  })
  .strict();
export type MappingOptions = z.infer<typeof mappingOptionsSchema>;

export const mappingSchema = z
  .object({
    version: z.literal(1).default(1),
    lists: z.array(listMappingSchema).max(20),
    options: mappingOptionsSchema.optional(),
  })
  .strict();
export type Mapping = z.infer<typeof mappingSchema>;

// ------------------------------------------------------------ values

const DIGITS: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (DIGITS[d] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (DIGITS[d] = String(i)));
export const latinDigits = (s: string) => s.replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d]).replace(/[٫]/g, ".").replace(/[٬]/g, ",");

export const isEmptyValue = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

// a phone as 98...: mobiles 989xxxxxxxxx, landlines 98 + area code + number
export const normalizePhoneText = (v: string) => {
  let s = latinDigits(v).replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("0098")) s = s.slice(2);
  if (s.startsWith("0")) s = `98${s.slice(1)}`;
  if (/^9\d{9}$/.test(s)) s = `98${s}`;
  return s;
};

const numberOf = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return v;
  const s = latinDigits(v).replace(/[,\s]/g, "").replace(/(تومان|ریال|toman|rial|irr|irt)$/i, "");
  const n = Number(s);
  return s && Number.isFinite(n) ? n : v;
};

const transformOne = (v: unknown, t: RuleTransform): unknown => {
  if (v === undefined || v === null) return v;
  switch (t) {
    case "trim":
      return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
    case "digits":
      return typeof v === "string" ? latinDigits(v) : v;
    case "phone":
      return typeof v === "string" || typeof v === "number" ? normalizePhoneText(String(v)) : v;
    case "lower":
      return typeof v === "string" ? v.toLowerCase() : v;
    case "stripTitle":
      return typeof v === "string" ? v.replace(/^\s*(دکتر|دكتر|Dr\.?|Doctor)\s+/i, "").trim() : v;
    case "number":
      return numberOf(v);
    case "rialToToman": {
      const n = numberOf(v);
      return typeof n === "number" ? Math.round(n / 10) : v;
    }
    case "tomanToRial": {
      const n = numberOf(v);
      return typeof n === "number" ? Math.round(n * 10) : v;
    }
  }
  return v;
};

// how value maps and the built-in synonyms compare texts
export const valueKey = (v: unknown) =>
  latinDigits(String(v ?? ""))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s_\-‌]+/g, "")
    .toLowerCase();

const mapValue = (v: unknown, map?: Record<string, string>) => {
  if (!map || v === undefined || v === null || typeof v === "object") return v;
  const key = valueKey(v);
  for (const [from, to] of Object.entries(map)) if (valueKey(from) === key) return to;
  return v;
};

// what an exporter writes for "no value" (Python's None, JS's null...)
const NO_VALUE = /^(none|null|undefined|nan|n\/a|-)$/i;

// fields the import resolves against our catalogues part by part
// (Services/providerImport.ts): their value map is keyed by those parts,
// not by the raw text
export const RESOLVED_FIELDS = new Set(["mainSpeciality", "specialities", "insurances", "services", "diseases"]);

// «دکتر زهرا فلاح|03537332728» -> a short stable hash of the normalised
// parts (title, spacing, letters and phone format blind)
export const hashOf = (v: unknown, join: string) => {
  const parts = String(v ?? "")
    .split(join || "|")
    .map((p) => {
      const t = p.replace(/^\s*(دکتر|دكتر|Dr\.?|Doctor)\s+/i, "");
      const phone = normalizePhoneText(t);
      return /^\d{8,}$/.test(phone) ? phone : matchKey(t);
    })
    .filter(Boolean);
  return parts.length ? crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16) : undefined;
};

const runExtract = (v: unknown, rule: MappingRule): unknown => {
  switch (rule.extract) {
    case "urlId":
      return idFromUrl(v);
    case "imageUrl":
      return unwrapImageUrl(v);
    case "hashId":
      return hashOf(v, rule.join ?? " ");
    default:
      return v;
  }
};

export const applyRule = (record: unknown, rule: MappingRule | undefined, ctx: { field?: string } = {}): unknown => {
  if (!rule) return undefined;
  let v: unknown;
  if (rule.sources?.length) {
    const parts = rule.sources
      .flatMap((p) => {
        const x = readPath(record, p);
        return Array.isArray(x) ? x : [x];
      })
      .filter((x) => !isEmptyValue(x) && typeof x !== "object")
      .map((x) => String(x).trim());
    v = parts.length ? parts.join(rule.join ?? " ") : undefined;
  } else if (rule.source) v = readPath(record, rule.source);
  if (typeof v === "string" && NO_VALUE.test(v.trim())) v = undefined;
  if (rule.extract && !isEmptyValue(v)) v = runExtract(v, rule);
  if (isEmptyValue(v) && rule.constant !== undefined) v = rule.constant;
  // text clean-ups run on the whole text, before it is split; value
  // conversions (phone, number, price unit) on each part after
  const each = (list: readonly RuleTransform[]) => {
    for (const t of rule.transforms || []) if (list.includes(t)) v = Array.isArray(v) ? v.map((x) => transformOne(x, t)) : transformOne(v, t);
  };
  each(TEXT_TRANSFORMS);
  if (rule.split && (typeof v === "string" || typeof v === "number")) {
    const parts = String(v)
      .split(rule.split.by)
      .map((p) => p.trim())
      .filter(Boolean);
    if (rule.split.index === undefined) v = parts;
    else {
      const i = rule.split.index < 0 ? parts.length + rule.split.index : rule.split.index;
      v = rule.split.rest ? parts.slice(Math.max(0, i)).join(" ") || undefined : parts[i];
    }
  }
  each(VALUE_TRANSFORMS);
  if (rule.valueMap && !(ctx.field && RESOLVED_FIELDS.has(ctx.field)))
    v = Array.isArray(v) ? v.map((x) => mapValue(x, rule.valueMap)) : mapValue(v, rule.valueMap);
  if (rule.prefix && (typeof v === "string" || typeof v === "number") && !isEmptyValue(v)) v = `${rule.prefix}${v}`;
  return v;
};

// one source record -> one record of our format (with its child lists)
export type MappedRecord = Record<string, unknown> & { translations?: Record<string, Record<string, unknown>> };

export const mapRecord = (record: unknown, list: ListMapping, options?: MappingOptions): MappedRecord => {
  const out: MappedRecord = {};
  for (const [key, rule] of Object.entries(list.fields || {})) {
    const [fieldName] = key.split("@");
    // a doctor's catalogue names keep their value map for the resolver
    const resolved = list.kind === "doctor" && RESOLVED_FIELDS.has(fieldName) && fieldName !== "insurances";
    const value = applyRule(record, rule, { field: resolved ? fieldName : undefined });
    if (isEmptyValue(value)) continue;
    const [field, locale] = key.split("@");
    if (locale) {
      out.translations ||= {};
      (out.translations[locale] ||= {})[field] = value;
    } else out[field] = value;
  }
  for (const child of list.children || []) {
    const spec = kindChildren[list.kind].find((c) => c.kind === child.kind);
    if (!spec) continue;
    const items = child.path ? readPath(record, child.path) : undefined;
    const list2 = Array.isArray(items) ? items : items && typeof items === "object" ? [items] : [];
    const mapped = list2.map((item) => mapRecord(item, child, options));
    if (mapped.length) out[spec.key] = [...((out[spec.key] as unknown[]) || []), ...mapped];
  }
  return out;
};

// ------------------------------------------------------------ suggestions

const fieldFits = (field: TargetField, p: SourcePath) => {
  const values = p.samples.map((s) => latinDigits(s.replace(/^"|"$/g, "")));
  switch (field.type) {
    case "lat":
    case "lng":
    case "number":
    case "price":
      return p.type === "number" || values.every((s) => /^-?[\d.,\s]+$/.test(s));
    case "point":
      return values.some((s) => /^\s*-?\d+(\.\d+)?\s*[,،\s]\s*-?\d+(\.\d+)?\s*$/.test(s));
    case "list":
    case "refList":
    case "phoneList":
      return p.type !== "object";
    case "boolean":
      return p.type === "boolean" || values.every((s) => /^(true|false|0|1|yes|no|بله|خیر)$/i.test(s));
    default:
      return p.type !== "object" && (p.type !== "list" || p.path.endsWith("[]"));
  }
};

const scoreOf = (field: TargetField, p: SourcePath) => {
  const key = nameKey(p.path);
  const syn = [field.key.toLowerCase(), ...(field.synonyms || [])].map((s) => nameKey(s));
  let score = 0;
  if (key === field.key.toLowerCase()) score = 100;
  else if (syn.includes(key)) score = 90 - syn.indexOf(key);
  else if (!/\[/.test(p.path) && syn.some((s) => s.length > 3 && (key.includes(s) || s.includes(key)) && key.length > 2)) score = 40;
  if (!score) return 0;
  if (!fieldFits(field, p)) return 0;
  // shallower paths and fields most records have win
  score -= (p.path.match(/[.[]/g) || []).length * 3;
  score += Math.min(10, p.count / 10);
  return score;
};

export const suggestFields = (kind: AnyKind, source: SourceList, skipPrefixes: string[] = []): Record<string, MappingRule> => {
  const fields: Record<string, MappingRule> = {};
  // every (field, path) pair scored, the best taken first: "fullname" goes
  // to fullName (exact) before firstName (its "name" synonym) can take it
  const pairs: { field: TargetField; p: SourcePath; score: number }[] = [];
  const paths = source.fields.filter((p) => p.type !== "object" && !skipPrefixes.some((pre) => p.path === pre || p.path.startsWith(`${pre}[`) || p.path.startsWith(`${pre}.`)));
  for (const field of kindFields[kind])
    for (const p of paths) {
      const score = scoreOf(field, p);
      if (score) pairs.push({ field, p, score });
    }
  pairs.sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  for (const { field, p } of pairs) {
    if (fields[field.key] || used.has(p.path)) continue;
    used.add(p.path);
    const rule: MappingRule = { source: p.path };
    if (field.type === "phone" || field.type === "phoneList") rule.transforms = ["phone"];
    if (field.type === "list" && !p.path.endsWith("[]") && p.type === "string") rule.split = { by: "," };
    fields[field.key] = rule;
  }
  // a full name but no separate first / last: split it
  if (kind === "doctor" && fields.fullName && !fields.firstName && !fields.lastName) {
    const src = fields.fullName.source;
    fields.firstName = { source: src, transforms: ["stripTitle"], split: { by: " ", index: 0 } };
    fields.lastName = { source: src, transforms: ["stripTitle"], split: { by: " ", index: 1, rest: true } };
    delete fields.fullName;
  }
  if (fields.point && (fields.lat || fields.lng)) delete fields.point;
  return fields;
};

// the fields under an object path of a list, as the fields of a one-item list
export const objectAsList = (source: SourceList, prefix: string): SourceList => ({
  path: prefix,
  count: source.fields.find((f) => f.path === prefix)?.count || 0,
  fields: source.fields
    .filter((f) => f.path.startsWith(`${prefix}.`))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length + 1) })),
  children: [],
});

export const suggestList = (kind: AnyKind, source: SourceList): ListMapping => {
  const children: ListMapping[] = [];
  const takenChild = new Set<string>();
  for (const spec of kindChildren[kind]) {
    const syn = [spec.key.toLowerCase(), ...spec.synonyms].map((s) => nameKey(s));
    let found = source.children.find((c) => !takenChild.has(c.path) && syn.includes(nameKey(c.path)));
    // one nested object is one child record (a doctor's `visit: {...}`)
    if (!found) {
      const obj = source.fields.find((f) => f.type === "object" && !/\[/.test(f.path) && !takenChild.has(f.path) && syn.includes(nameKey(f.path)));
      if (obj) found = objectAsList(source, obj.path);
    }
    if (!found) continue;
    takenChild.add(found.path);
    children.push({ ...suggestList(spec.kind, found), path: found.path });
  }
  // the fields of a list mapped as child records are the children's
  return { path: source.path, kind, fields: suggestFields(kind, source, children.map((c) => c.path)), children };
};

export const guessKind = (source: SourceList): ImportKind | null => {
  const key = nameKey(source.path || "");
  for (const kind of importKinds) if (kindSynonyms[kind].map(nameKey).includes(key)) return kind;
  const keys = new Set(source.fields.map((f) => nameKey(f.path)));
  const has = (...names: string[]) => names.some((n) => keys.has(nameKey(n)));
  if (has("medicalcode", "nezam", "medicalsystemcode", "firstname", "lastname", "speciality", "expertise", "specialty", "تخصص", "نظام پزشکی"))
    return "doctor";
  return null;
};

// ------------------------------------------------------------ native format

const identity = (kind: AnyKind): ListMapping => {
  const fields: Record<string, MappingRule> = {};
  for (const f of kindFields[kind]) fields[f.key] = { source: f.key };
  // translations given in the file itself (translations.en.firstName)
  fields.translations = { source: "translations" } as never;
  return {
    path: "",
    kind,
    fields,
    children: kindChildren[kind].map((c) => ({ ...identity(c.kind as ChildKind), path: c.key })),
  };
};

export const isNativeFile = (root: unknown) =>
  !!root &&
  typeof root === "object" &&
  !Array.isArray(root) &&
  (root as Record<string, unknown>).version === 1 &&
  Object.keys(nativeListKeys).some((k) => Array.isArray((root as Record<string, unknown>)[k]));

export const nativeMapping = (root: unknown): Mapping => {
  const lists: ListMapping[] = [];
  if (root && typeof root === "object" && !Array.isArray(root))
    for (const [key, kind] of Object.entries(nativeListKeys))
      if (Array.isArray((root as Record<string, unknown>)[key])) lists.push({ ...identity(kind), path: key });
  return { version: 1, lists };
};

// what the upload answers: the record lists found, their fields, and a
// suggested mapping (1:1 for our own format)
export const analyseFile = (root: unknown) => {
  const native = isNativeFile(root);
  const found = findRecordLists(root);
  const lists = found.map(({ path, records }) => analyseRecords(records, path));
  const suggestion: Mapping = native
    ? nativeMapping(root)
    : {
        version: 1,
        lists: lists
          .map((l) => {
            const kind = guessKind(l);
            return kind ? suggestList(kind, l) : null;
          })
          .filter(Boolean) as ListMapping[],
      };
  // a suggestion for every list as every kind: the panel shows it when the
  // admin picks (or changes) what a list is
  const suggestions: Record<string, Partial<Record<ImportKind, ListMapping>>> = {};
  for (const l of lists) suggestions[l.path] = Object.fromEntries(importKinds.map((k) => [k, suggestList(k, l)]));
  return { native, lists, suggestion, suggestions };
};

export { recordsAt };
