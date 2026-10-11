// Bulk provider import: reading a source JSON file of ANY shape (2026-10).
// The admin uploads what their source exports - an array of records, or an
// object that holds record arrays at any depth, with nested objects and
// lists inside each record. This finds the record lists, lists every field
// path of a list's records (with a few sample values) for the mapping
// table, and reads one path out of a record.
//
// Path syntax (the mapping's `source`): dot-separated keys, `[n]` picks one
// item of a list, `[]` takes every item: `info.name`, `addresses[0].lat`,
// `expertise[]`, `expertise[].title`. The empty path is the record itself
// (or the file itself when it is a top-level array).

type Segment = { key?: string; index?: number | "*" };

const SEGMENT = /([^.[\]]+)|\[(\d*)\]/g;

export const parsePath = (path: string): Segment[] => {
  const out: Segment[] = [];
  if (!path) return out;
  for (const m of path.matchAll(SEGMENT)) {
    if (m[1] !== undefined) out.push({ key: m[1] });
    else out.push({ index: m[2] === "" ? "*" : Number(m[2]) });
  }
  return out;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// the value at `path` in `root`; a path with `[]` returns a list of every
// match (empty values left out)
export const readPath = (root: unknown, path: string): unknown => {
  const segments = parsePath(path);
  let current: unknown[] = [root];
  let many = false;
  for (const seg of segments) {
    if (seg.key !== undefined) {
      const key = seg.key;
      current = current.map((v) => (isObject(v) ? v[key] : undefined));
    } else if (seg.index === "*") {
      many = true;
      current = current.flatMap((v) => (Array.isArray(v) ? v : []));
    } else {
      const i = seg.index as number;
      current = current.map((v) => (Array.isArray(v) ? v[i] : undefined));
    }
  }
  if (many) return current.filter((v) => v !== undefined && v !== null && v !== "");
  return current[0];
};

// ------------------------------------------------------------ analysis

export type SourcePath = {
  path: string;
  // up to 3 distinct values, as text
  samples: string[];
  // how many of the sampled records have a value there
  count: number;
  type: "string" | "number" | "boolean" | "list" | "object";
};

export type SourceList = {
  // where the list is (top level: in the file; child: in its parent record)
  path: string;
  count: number;
  fields: SourcePath[];
  // record lists inside each record (e.g. a doctor's `clinics`)
  children: SourceList[];
};

const SAMPLE_RECORDS = 300;
const MAX_PATHS = 400;
const MAX_DEPTH = 6;

const sampleText = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const typeOf = (v: unknown): SourcePath["type"] =>
  Array.isArray(v) ? "list" : isObject(v) ? "object" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";

const isRecordList = (v: unknown): v is Record<string, unknown>[] => {
  if (!Array.isArray(v) || !v.length) return false;
  const objects = v.slice(0, 50).filter(isObject).length;
  return objects > 0 && objects >= Math.min(v.length, 50) / 2;
};

type Acc = Map<string, { samples: string[]; count: number; type: SourcePath["type"]; seen: Set<string> }>;

const note = (acc: Acc, path: string, value: unknown, seenIn: Set<string>) => {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value) && !value.length) return;
  let entry = acc.get(path);
  if (!entry) {
    if (acc.size >= MAX_PATHS) return;
    entry = { samples: [], count: 0, type: typeOf(value), seen: new Set() };
    acc.set(path, entry);
  }
  if (!seenIn.has(path)) {
    entry.count++;
    seenIn.add(path);
  }
  const text = sampleText(value);
  if (entry.samples.length < 3 && !entry.seen.has(text)) {
    entry.seen.add(text);
    entry.samples.push(text);
  }
};

// the field paths of one record, and the record lists inside it
const flatten = (
  value: unknown,
  prefix: string,
  depth: number,
  acc: Acc,
  childLists: Map<string, Record<string, unknown>[]>,
  seenIn: Set<string>,
) => {
  if (depth > MAX_DEPTH || !isObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(v)) {
      if (isRecordList(v)) {
        // a child list: mapped as child records, and its first item's
        // fields can be picked directly (`addresses[0].lat`)
        const list = childLists.get(path) || [];
        for (const item of v) if (isObject(item) && list.length < SAMPLE_RECORDS) list.push(item);
        childLists.set(path, list);
        note(acc, path, v, seenIn);
        flatten(v[0], `${path}[0]`, depth + 1, acc, new Map(), seenIn);
      } else {
        const items = v.filter((x) => x !== null && x !== undefined && x !== "" && !isObject(x) && !Array.isArray(x));
        if (items.length) note(acc, `${path}[]`, items, seenIn);
      }
    } else if (isObject(v)) {
      // an object can be mapped as one child record (e.g. a doctor's `visit`)
      note(acc, path, v, seenIn);
      flatten(v, path, depth + 1, acc, childLists, seenIn);
    } else {
      note(acc, path, v, seenIn);
    }
  }
};

export const analyseRecords = (records: unknown[], path: string, depth = 0): SourceList => {
  const acc: Acc = new Map();
  const childLists = new Map<string, Record<string, unknown>[]>();
  for (const record of records.slice(0, SAMPLE_RECORDS)) flatten(record, "", 0, acc, childLists, new Set());
  const fields = [...acc.entries()].map(([p, e]) => ({ path: p, samples: e.samples, count: e.count, type: e.type }));
  const children =
    depth < 2
      ? [...childLists.entries()].map(([p, items]) => analyseRecords(items, p, depth + 1))
      : [];
  return { path, count: records.length, fields, children };
};

// every record list of the file that is not inside another record
export const findRecordLists = (root: unknown): { path: string; records: Record<string, unknown>[] }[] => {
  const out: { path: string; records: Record<string, unknown>[] }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (isRecordList(v)) {
      out.push({ path, records: v.filter(isObject) });
      return;
    }
    if (isObject(v)) for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(root, "", 0);
  return out;
};

export const recordsAt = (root: unknown, path: string): Record<string, unknown>[] => {
  const v = path ? readPath(root, path) : root;
  return Array.isArray(v) ? v.filter(isObject) : [];
};

// a name as the auto-suggest compares it: lower case, no separators,
// Persian letters unified
export const nameKey = (s: string) =>
  s
    .replace(/\[\d*\]/g, "")
    .split(".")
    .pop()!
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s_\-‌]+/g, "")
    .toLowerCase();
