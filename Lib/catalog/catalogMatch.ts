import { faLetters, matchKey, nameVariants, similarity } from "../providerImport/textExtract";

// Catalogue name matching (2026-10, after a partner import turned every
// free-text «تخصص» into a new speciality). Pure: the database side
// (loading, the suggestions queue, merges) is Services/catalogCleanup.ts.
//
// One rule for every place that turns a written name into a catalogue
// entry - the bulk provider import, the duplicate finder of the admin's
// «ادغام و پاک‌سازی» tab and the onboarding's council title:
//  - the comparison key: Persian letters (ي / ك / ى, hamza and alef forms,
//    ه / ة), no diacritics, half-spaces, spaces, punctuation or
//    parentheses, Latin digits, lower case; for specialities also without
//    the level words («تخصص», «متخصص», «فوق تخصص», «فلوشیپ», «دکترای»,
//    «پزشک», «رشته») - as whole words, so «چشم‌پزشکی» stays itself;
//  - a name matches an entry by its name, its synonyms or a translation,
//    with or without what is in parentheses;
//  - else by similarity (shared words / letter pairs) to an entry the
//    catalogue trusts (canonical, or active when nothing is canonical),
//    only when it is nearly the same name (AUTO_SCORE);
//  - «A و B» is two entries only when every part is a known one.

export type CatalogKind = "speciality" | "disease" | "service";
export const catalogKinds: CatalogKind[] = ["speciality", "disease", "service"];

const SPLIT = /[\s‌‍\-_.،,؛;:()[\]{}«»"'/\\|]+/;
const LEVEL_TOKENS = new Set([
  "تخصص",
  "تخصصی",
  "متخصص",
  "متخصصین",
  "فلوشیپ",
  "فلوشیپی",
  "دکترای",
  "دکتری",
  "دکتر",
  "پزشک",
  "رشته",
  "دارای",
  "بورد",
  "specialist",
  "specialty",
  "speciality",
  "fellowship",
  "dr",
  "md",
]);

const tokensOf = (value: unknown) =>
  faLetters(String(value ?? ""))
    .normalize("NFKC")
    .split(SPLIT)
    .map((t) => t.trim())
    .filter(Boolean);

// a speciality's name without its level words: «فوق تخصص غدد کودکان» ->
// «غدد کودکان», «جراح و متخصص زنان و زایمان» -> «زنان و زایمان»
export const specialityCore = (value: unknown) => {
  const t = tokensOf(value);
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    const k = matchKey(w);
    if (k === "فوق" && /^(تخصص|تخصصی)$/.test(matchKey(t[i + 1] || ""))) continue;
    if (LEVEL_TOKENS.has(k)) continue;
    out.push(w);
  }
  // «جراح و ...»: the surgeon of the field that follows
  while (out.length > 2 && matchKey(out[0]) === "جراح" && out[1] === "و") out.splice(0, 2);
  while (out.length && out[0] === "و") out.shift();
  while (out.length && out[out.length - 1] === "و") out.pop();
  return out.join(" ");
};

export const keyOf = (kind: CatalogKind, value: unknown) => matchKey(kind === "speciality" ? specialityCore(value) : value);

// every key a name is known by (as written, without parentheses, the word
// in parentheses in place of the one before it)
export const keysOf = (kind: CatalogKind, value: unknown): string[] => {
  if (typeof value !== "string" || !value.trim()) return [];
  const out = new Set<string>();
  for (const v of nameVariants(faLetters(value).trim())) {
    const k = keyOf(kind, v);
    if (k.length >= 2) out.add(k);
  }
  return [...out];
};

// ------------------------------------------------------------ the index

export type MatchRow = {
  id: string;
  name: string;
  // synonyms and translated names
  aliases?: string[];
  canonical?: boolean;
  // active / published (an approved entry)
  active?: boolean;
  archived?: boolean;
  // an archived entry's target: its names lead there
  mergedInto?: string;
  tier?: string;
  doctors?: number;
};

export type Matcher = {
  kind: CatalogKind;
  rows: Map<string, MatchRow>;
  byKey: Map<string, MatchRow>;
  // the entries a fuzzy match may land on, with their comparable names
  pool: { row: MatchRow; names: string[] }[];
};

const rank = (r: MatchRow) => (r.canonical ? 4 : 0) + (r.active ? 2 : 0) + (r.archived ? -8 : 0);

export const buildMatcher = (kind: CatalogKind, input: MatchRow[]): Matcher => {
  const rows = new Map<string, MatchRow>();
  for (const r of input) if (r && r.id && typeof r.name === "string" && r.name.trim()) rows.set(r.id, r);
  const byKey = new Map<string, MatchRow>();
  // the target an archived entry was merged into (one hop is enough: a
  // merge re-points the earlier ones)
  const live = (r: MatchRow): MatchRow | undefined => {
    if (!r.archived) return r;
    const t = r.mergedInto ? rows.get(r.mergedInto) : undefined;
    return t && !t.archived ? t : undefined;
  };
  const ordered = [...rows.values()].sort((a, b) => rank(b) - rank(a) || (b.doctors || 0) - (a.doctors || 0));
  // own names first, then synonyms / translations: a name always wins over
  // another entry's synonym
  for (const pass of [0, 1] as const)
    for (const r of ordered) {
      const target = live(r);
      if (!target) continue;
      const names = pass === 0 ? [r.name] : r.aliases || [];
      for (const n of names) for (const k of keysOf(kind, n)) if (!byKey.has(k)) byKey.set(k, target);
    }
  const live2 = ordered.filter((r) => !r.archived);
  const trusted = live2.some((r) => r.canonical) ? live2.filter((r) => r.canonical) : live2.filter((r) => r.active);
  const pool = trusted.map((row) => ({
    row,
    names: [row.name, ...(row.aliases || [])]
      .filter((n): n is string => typeof n === "string" && !!n.trim())
      .map((n) => (kind === "speciality" ? specialityCore(n) : faLetters(n)))
      .filter((n) => matchKey(n).length >= 2),
  }));
  return { kind, rows, byKey, pool };
};

// ------------------------------------------------------------ matching

// a near name is the same entry from this score up; between HINT_SCORE and
// it, the entry is only offered to the admin
export const AUTO_SCORE = 0.86;
export const HINT_SCORE = 0.6;

export type MatchResult =
  | { status: "exact"; row: MatchRow; score: 1 }
  | { status: "fuzzy"; row: MatchRow; score: number }
  | { status: "none"; hint?: MatchRow; score: number };

export const exactMatch = (m: Matcher, value: unknown): MatchRow | undefined => {
  for (const k of keysOf(m.kind, value)) {
    const hit = m.byKey.get(k);
    if (hit) return hit;
  }
  return undefined;
};

const nearest = (m: Matcher, value: string) => {
  const variants = nameVariants(faLetters(value).trim()).map((v) => (m.kind === "speciality" ? specialityCore(v) : v)).filter((v) => matchKey(v).length >= 2);
  let best: { row: MatchRow; score: number } | undefined;
  for (const p of m.pool)
    for (const n of p.names)
      for (const v of variants) {
        const s = similarity(v, n);
        if (!best || s > best.score || (s === best.score && rank(p.row) > rank(best.row))) best = { row: p.row, score: s };
      }
  return best;
};

export const matchName = (m: Matcher, value: unknown): MatchResult => {
  if (typeof value !== "string" || matchKey(value).length < 2) return { status: "none", score: 0 };
  const hit = exactMatch(m, value);
  if (hit) return { status: "exact", row: hit, score: 1 };
  const near = nearest(m, value);
  if (near && near.score >= AUTO_SCORE) return { status: "fuzzy", row: near.row, score: near.score };
  return { status: "none", hint: near && near.score >= HINT_SCORE ? near.row : undefined, score: near?.score || 0 };
};

// «داخلی و قلب»: every part a known entry (the fewest parts) - else nothing
export const splitByAnd = (m: Matcher, value: unknown): MatchRow[] | undefined => {
  if (typeof value !== "string") return undefined;
  const core = m.kind === "speciality" ? specialityCore(value) : faLetters(value);
  const chunks = core.split(/\s+و\s+|\s*،\s*|\s*,\s*/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length < 2) return undefined;
  const best: (MatchRow[] | undefined)[] = new Array(chunks.length + 1);
  best[0] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= chunks.length; j++) {
      const part = chunks.slice(i, j).join(" و ");
      const r = matchName(m, part);
      if (r.status === "none") continue;
      const cand = [...best[i]!, r.row];
      if (!best[j] || cand.length < best[j]!.length) best[j] = cand;
    }
  }
  const out = best[chunks.length];
  if (!out || out.length < 2) return undefined;
  return out.filter((r, i) => out.findIndex((o) => o.id === r.id) === i);
};

// ------------------------------------------------------------ duplicates

export type DuplicateGroup = {
  target: MatchRow;
  members: { row: MatchRow; why: "key" | "synonym" | "similar" | "canonical"; score: number }[];
};

// The groups the admin's merge tab suggests: an entry that is not canonical
// goes into the canonical one it matches (by key, synonym or a near name);
// what matches no canonical entry is grouped with its own kind by key and
// by a near name. Two canonical entries are never put together. The target
// is the canonical one, else the most used (then the active, the oldest).
export const findDuplicates = (m: Matcher, opts: { similar?: number } = {}): DuplicateGroup[] => {
  const similar = opts.similar ?? 0.9;
  const live = [...m.rows.values()].filter((r) => !r.archived);
  const canonical = live.filter((r) => r.canonical);
  const canonMatcher = canonical.length ? buildMatcher(m.kind, canonical) : undefined;
  const groups = new Map<string, DuplicateGroup>();
  const add = (target: MatchRow, row: MatchRow, why: DuplicateGroup["members"][number]["why"], score: number) => {
    const g = groups.get(target.id) || { target, members: [] };
    if (!g.members.some((x) => x.row.id === row.id) && row.id !== target.id) g.members.push({ row, why, score });
    groups.set(target.id, g);
  };
  const rest: MatchRow[] = [];
  for (const r of live) {
    if (r.canonical) continue;
    if (canonMatcher) {
      const own = keysOf(m.kind, r.name);
      const byName = own.map((k) => canonMatcher.byKey.get(k)).find(Boolean);
      if (byName) {
        const sameName = keysOf(m.kind, byName.name).some((k) => own.includes(k));
        add(byName, r, sameName ? "key" : "synonym", 1);
        continue;
      }
      const near = nearest(canonMatcher, r.name);
      if (near && near.score >= AUTO_SCORE) {
        add(near.row, r, "canonical", Math.round(near.score * 100) / 100);
        continue;
      }
    }
    rest.push(r);
  }
  // the rest among themselves: union by key, then by near names within a
  // shared word (no all-pairs scan over thousands of entries)
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) || x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const how = new Map<string, { why: "key" | "similar"; score: number }>();
  const byKey = new Map<string, string>();
  for (const r of rest)
    for (const k of keysOf(m.kind, r.name)) {
      const other = byKey.get(k);
      if (other) {
        union(r.id, other);
        how.set(r.id, { why: "key", score: 1 });
        if (!how.has(other)) how.set(other, { why: "key", score: 1 });
      } else byKey.set(k, r.id);
    }
  const words = new Map<string, MatchRow[]>();
  const core = (r: MatchRow) => (m.kind === "speciality" ? specialityCore(r.name) : faLetters(r.name));
  for (const r of rest)
    for (const w of new Set(tokensOf(core(r)).map(matchKey).filter((w) => w.length >= 3))) {
      const list = words.get(w) || [];
      list.push(r);
      words.set(w, list);
    }
  for (const list of words.values()) {
    if (list.length < 2 || list.length > 300) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (find(list[i].id) === find(list[j].id)) continue;
        const s = similarity(core(list[i]), core(list[j]));
        if (s >= similar) {
          union(list[i].id, list[j].id);
          if (!how.has(list[j].id)) how.set(list[j].id, { why: "similar", score: Math.round(s * 100) / 100 });
        }
      }
  }
  const clusters = new Map<string, MatchRow[]>();
  for (const r of rest) {
    const root = find(r.id);
    const list = clusters.get(root) || [];
    list.push(r);
    clusters.set(root, list);
  }
  for (const list of clusters.values()) {
    if (list.length < 2) continue;
    const target = [...list].sort((a, b) => (b.doctors || 0) - (a.doctors || 0) || Number(!!b.active) - Number(!!a.active) || (a.id < b.id ? -1 : 1))[0];
    for (const r of list) if (r.id !== target.id) add(target, r, how.get(r.id)?.why || "similar", how.get(r.id)?.score ?? 1);
  }
  return [...groups.values()]
    .filter((g) => g.members.length)
    .sort((a, b) => b.members.reduce((s, x) => s + (x.row.doctors || 0), 0) - a.members.reduce((s, x) => s + (x.row.doctors || 0), 0) || b.members.length - a.members.length);
};
