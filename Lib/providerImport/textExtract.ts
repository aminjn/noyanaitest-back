// Bulk provider import: text helpers (2026-10). Name comparison keys, the
// speciality titles («تخصص X-فلوشیپ Y»), the weekly hours written as text,
// and lists written as names joined by spaces with no separator (a partner
// directory's conditions / services). Free-text introductions are stored
// as given: nothing is read out of them. Everything here is pure (no
// database): the catalogue lookups live in Services/providerImportResolve.ts
// and pass their index in.

const DIGITS: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (DIGITS[d] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (DIGITS[d] = String(i)));
const latin = (s: string) => s.replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d]);

const ZWNJ = /[‌‍‎‏  ]/g;

// Persian letters for display (Arabic ي / ك / ى unified, nothing else changed)
export const faLetters = (s: string) => s.replace(/[يى]/g, "ی").replace(/ك/g, "ک");

// the comparison key of a name: Persian letters, hamza and alef forms, ه/ة,
// no diacritics, no half-space / space / punctuation, Latin digits, lower case
export const matchKey = (value: unknown) =>
  latin(faLetters(String(value ?? "")))
    .replace(/[أإٱآ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/[ةۀ]/g, "ه")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(ZWNJ, "")
    .replace(/[\s\-_.،,؛;:()[\]{}«»"'/\\|]+/g, "")
    .toLowerCase();

// ------------------------------------------------------------ simple facts

// a stable id of a profile link: its numeric path part
// (https://drdr.ir/dr/71461/دکتر-... -> 71461), else its last part
export const idFromUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const numeric = parts.find((p) => /^\d+$/.test(p));
    return (numeric || parts[parts.length - 1] || u.hostname).slice(0, 120);
  } catch {
    return value.trim().slice(0, 120);
  }
};

// a Next.js image proxy link (/_next/image/?url=<the file>&w=96) -> the file
export const unwrapImageUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    const inner = u.pathname.includes("/_next/image") ? u.searchParams.get("url") : null;
    if (inner) return new URL(inner, u.origin).toString();
    return u.toString();
  } catch {
    return undefined;
  }
};

// «یزد-بلوار طالقانی، ...», «فارس-شیراز-خیابان ...» -> the leading names
export const addressPrefixNames = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  const parts = faLetters(value).split(/\s*-\s*/);
  const out: string[] = [];
  // the street part starts where a comma or a digit shows up
  for (const p of parts.slice(0, -1)) {
    if (!p || /[،,\d۰-۹]/.test(p) || p.split(/\s+/).length > 3) break;
    out.push(p.trim());
    if (out.length === 2) break;
  }
  return out;
};

// ------------------------------------------------------------ office hours

export type HoursRow = { days: number[]; from: number; to: number };

const DAY_WORDS: [RegExp, number][] = [
  [/^یکشنبه$/, 1],
  [/^دوشنبه$/, 2],
  [/^سهشنبه$/, 3],
  [/^چهارشنبه$/, 4],
  [/^پنجشنبه$/, 5],
  [/^جمعه$/, 6],
  [/^شنبه$/, 0],
];
const PM = /^(عصر|بعدازظهر|بعدازظهرها|شب|غروب|عصرها|شبها)$/;
const AM = /^(صبح|صبحها|بامداد)$/;
const NOON = /^(ظهر)$/;

const tokensOfHours = (s: string) =>
  latin(faLetters(s))
    .replace(ZWNJ, "")
    .replace(/یک\s+شنبه/g, "یکشنبه")
    .replace(/سه\s+شنبه/g, "سهشنبه")
    .replace(/پنج\s+شنبه/g, "پنجشنبه")
    .replace(/بعد\s*از\s*ظهر/g, "بعدازظهر")
    .replace(/(\d)\s*[:٫.]\s*(\d{2})/g, "$1:$2")
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 تا $2")
    .replace(/[،,؛;()«»●•▪*]/g, " ")
    .replace(/(\D):/g, "$1 ")
    .split(/\s+/)
    .map((w) => w.replace(/^(روزهای|روز|روزها)$/, ""))
    .filter(Boolean);

const dayOfWord = (w: string) => {
  const clean = w.replace(/[.!؟:]+$/, "").replace(/(شنبه|جمعه)(ها|های)$/, "$1");
  for (const [re, d] of DAY_WORDS) if (re.test(clean)) return d;
  return undefined;
};

const timeOf = (w: string): number | undefined => {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(w.replace(/[.!؟]$/, ""));
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 24 || min > 59) return undefined;
  return h * 60 + min;
};

// «شنبه تا چهارشنبه ۱۷ تا ۲۱ یا پنج شنبه از ۱۸ تا ۲۰», «شنبه و سه‌شنبه از
// ساعت 14:20 عصر تا 18 غروب», «همه روزه به جز جمعه ۹ تا ۱۳» -> weekly rows
// (0 = Saturday). Only what reads clearly; anything else is left out.
export const parseHoursText = (text: unknown): HoursRow[] => {
  if (typeof text !== "string" || !text.trim()) return [];
  const w = tokensOfHours(text);
  const rows: HoursRow[] = [];
  let days: number[] = [];
  let lastWasDay = false;
  for (let i = 0; i < w.length; i++) {
    const tok = w[i];
    // days: «X تا Y», «X و Y», «همه روزه / هر روز», «به جز X»
    if ((tok === "همه" || tok === "هر") && /^(روزه|روز)$/.test(w[i + 1] || "")) {
      days = [0, 1, 2, 3, 4, 5, 6];
      i++;
      lastWasDay = true;
      continue;
    }
    if ((tok === "بجز" || tok === "جز" || (tok === "غیر" && w[i + 1] === "از")) && days.length) {
      let j = i + 1;
      if (w[j] === "از" || w[j] === "جز") j++;
      const d = dayOfWord(w[j] || "");
      if (d !== undefined) {
        days = days.filter((x) => x !== d);
        i = j;
      }
      continue;
    }
    // «روزهای زوج / فرد» (Saturday, Monday, Wednesday / Sunday, Tuesday, Thursday)
    if (/^(زوج|فرد)$/.test(tok.replace(/[.!؟:]+$/, ""))) {
      if (!lastWasDay) days = [];
      for (const x of tok.startsWith("زوج") ? [0, 2, 4] : [1, 3, 5]) if (!days.includes(x)) days.push(x);
      lastWasDay = true;
      continue;
    }
    const d = dayOfWord(tok);
    if (d !== undefined) {
      if (!lastWasDay) days = [];
      if ((w[i + 1] === "تا" || w[i + 1] === "الی") && dayOfWord(w[i + 2] || "") !== undefined) {
        const e = dayOfWord(w[i + 2])!;
        for (let x = d; ; x = (x + 1) % 7) {
          if (!days.includes(x)) days.push(x);
          if (x === e) break;
        }
        i += 2;
      } else if (!days.includes(d)) days.push(d);
      lastWasDay = true;
      continue;
    }
    if (tok === "و" && lastWasDay) continue;
    // times: «(از) (ساعت) T (period) تا|الی (ساعت) T (period)»
    let j = i;
    if (w[j] === "از") j++;
    if (w[j] === "ساعت") j++;
    const from = timeOf(w[j] || "");
    if (from !== undefined && days.length) {
      let k = j + 1;
      let fromPeriod = "";
      if (PM.test(w[k] || "") || AM.test(w[k] || "") || NOON.test(w[k] || "")) fromPeriod = w[k++];
      if (w[k] === "تا" || w[k] === "الی") {
        k++;
        if (w[k] === "ساعت") k++;
        const to = timeOf(w[k] || "");
        if (to !== undefined) {
          let toPeriod = "";
          if (PM.test(w[k + 1] || "") || AM.test(w[k + 1] || "") || NOON.test(w[k + 1] || "")) toPeriod = w[k + 1];
          let a = from;
          let b = to;
          if (PM.test(fromPeriod) && a < 12 * 60) a += 12 * 60;
          if (PM.test(toPeriod) && b < 12 * 60) b += 12 * 60;
          if (!toPeriod && PM.test(fromPeriod) && b < 12 * 60) b += 12 * 60;
          // «۴ تا ۸» after noon, «۱۰ تا ۲» over noon
          if (b <= a && b + 12 * 60 > a && b < 12 * 60) b += 12 * 60;
          if (b === 0) b = 24 * 60;
          if (a < b && b <= 24 * 60 && b - a <= 16 * 60 && b - a >= 30) rows.push({ days: [...days].sort((x, y) => x - y), from: a, to: b });
          i = toPeriod ? k + 1 : k;
          lastWasDay = false;
          continue;
        }
      }
    }
    lastWasDay = false;
  }
  // the same range named twice
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.days.join(",")}|${r.from}|${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ------------------------------------------------------------ joined names

export type CatalogEntry = { id: string; name: string };
export type CatalogIndex = { byKey: Map<string, CatalogEntry>; maxWords: number };

export const buildCatalogIndex = (rows: { id: string; name: string; aliases?: string[] }[]): CatalogIndex => {
  const byKey = new Map<string, CatalogEntry>();
  let maxWords = 1;
  for (const r of rows)
    for (const n of [r.name, ...(r.aliases || [])]) {
      const key = matchKey(n);
      if (key.length < 2) continue;
      if (!byKey.has(key)) byKey.set(key, { id: r.id, name: r.name });
      maxWords = Math.max(maxWords, faLetters(n).replace(ZWNJ, " ").split(/\s+/).filter(Boolean).length);
    }
  return { byKey, maxWords: Math.min(maxWords + 1, 12) };
};

export type SplitResult = { matched: (CatalogEntry & { source: string })[]; leftovers: string[] };

type Unit = { text: string; paren: boolean };
const unitsOf = (text: string): Unit[] => {
  const out: Unit[] = [];
  const re = /\(([^)]*)\)|[^\s()]+/g;
  for (const m of faLetters(text).matchAll(re)) {
    if (m[1] !== undefined) {
      const inner = m[1].trim();
      if (inner) out.push({ text: `(${inner})`, paren: true });
    } else out.push({ text: m[0], paren: false });
  }
  return out;
};

// «زگیل تناسلی زنان خونریزی رحم افتادگی رحم» -> the catalogue names in it
// (the longest match first, case / half-space / spelling blind), and the
// chunks no catalogue name covers
export const splitJoined = (text: unknown, index: CatalogIndex): SplitResult => {
  const matched: SplitResult["matched"] = [];
  const leftovers: string[] = [];
  if (typeof text !== "string" || !text.trim()) return { matched, leftovers };
  const units = unitsOf(text);
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) leftovers.push(pending.join(" ").trim());
    pending = [];
  };
  let i = 0;
  while (i < units.length) {
    if (units[i].paren) {
      pending.push(units[i].text);
      i++;
      continue;
    }
    let hit: { entry: CatalogEntry; end: number } | null = null;
    for (let len = Math.min(index.maxWords, units.length - i); len >= 1 && !hit; len--) {
      const slice = units.slice(i, i + len);
      if (slice[slice.length - 1].paren && len > 1) continue;
      const words = slice.filter((u) => !u.paren).map((u) => u.text);
      const key = matchKey(words.join(" "));
      const entry = key.length >= 2 ? index.byKey.get(key) : undefined;
      if (entry) hit = { entry, end: i + len };
    }
    // a word in parentheses may be the catalogue's name («(HPV)»)
    if (!hit && units[i + 1]?.paren) {
      const entry = index.byKey.get(matchKey(units[i + 1].text));
      if (entry) hit = { entry, end: i + 1 };
    }
    if (!hit) {
      pending.push(units[i].text);
      i++;
      continue;
    }
    flush();
    let end = hit.end;
    const source = [units.slice(i, end).map((u) => u.text).join(" ")];
    // its explanation in parentheses goes with it
    while (units[end]?.paren) source.push(units[end++].text);
    if (!matched.some((m) => m.id === hit!.entry.id)) matched.push({ ...hit.entry, source: source.join(" ") });
    i = end;
  }
  flush();
  return { matched, leftovers: leftovers.filter((l) => matchKey(l).length >= 2) };
};

// ------------------------------------------------------------ names learnt from the file

// What is left of a joined list after the catalogue match
// («تبخال تناسلی سوزاک افتادگی لگن») is split with what the file itself
// shows: a partner lists the same names for many doctors, each time in
// another order, so two words that keep going together are one name and a
// pair that comes together only now and then is a boundary. Learnt once
// per file and field (learnJoinedNames), applied to the leftovers
// (splitLearnt). Each part becomes one new catalogue entry.

// a word with its explanation in parentheses («قاعدگی (پریود)») is one unit
const learntUnits = (text: string): string[] => {
  const out: string[] = [];
  for (const m of faLetters(text).matchAll(/\(([^)]*)\)|[^\s()]+/g)) {
    if (m[1] !== undefined) {
      const inner = m[1].replace(/\s+/g, " ").trim();
      if (!inner) continue;
      if (out.length) out[out.length - 1] = `${out[out.length - 1]} (${inner})`;
      else out.push(`(${inner})`);
    } else out.push(m[0]);
  }
  return out;
};

// words that never start or end a name («و», «در», «های»...)
const LINK_WORD = /^(و|یا|از|در|با|به|بعد|قبل|بدون|های|ها|برای|تا|پس|پیش)$/;

export type LearntNames = {
  pairs: Map<string, number>;
  notEnd: Map<string, number>;
  notStart: Map<string, number>;
  ends: Map<string, [number, number]>;
  starts: Map<string, [number, number]>;
  // names seen as one segment in two records or more
  names: Set<string>;
  maxUnits: number;
};

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
const bumpRate = (m: Map<string, [number, number]>, k: string, hit: boolean) => {
  const cur = m.get(k) || [0, 0];
  m.set(k, [cur[0] + (hit ? 1 : 0), cur[1] + 1]);
};
const pairKey = (a: string, b: string) => `${matchKey(a)}|${matchKey(b)}`;

// two units seen together at least twice: one name when one predicts the
// other, a boundary when each usually goes with something else
const pairRule = (m: LearntNames, a: string, b: string): "join" | "cut" | undefined => {
  const c = m.pairs.get(pairKey(a, b)) || 0;
  if (c < 2) return undefined;
  const f = c / (m.notEnd.get(matchKey(a)) || 1);
  const g = c / (m.notStart.get(matchKey(b)) || 1);
  return Math.max(f, g) > 0.4 || (c >= 3 && Math.min(f, g) >= 0.25) ? "join" : "cut";
};

const boundary = (m: LearntNames, a: string, b: string): boolean => {
  if (LINK_WORD.test(a) || LINK_WORD.test(b)) return false;
  // an explanation in parentheses closes a name («... (دیسمنوره)»), unless
  // the next word nearly always follows («دخول (مقاربت) دردناک»)
  if (/\)$/.test(a)) {
    const c = m.pairs.get(pairKey(a, b)) || 0;
    return !(c >= 3 && c / (m.notEnd.get(matchKey(a)) || 1) > 0.6);
  }
  const rule = pairRule(m, a, b);
  if (rule) return rule === "cut";
  // seen together once: a word that usually ends a name, or one that usually
  // starts one, marks the boundary; two rare words stay together
  const e = m.ends.get(matchKey(a));
  const s = m.starts.get(matchKey(b));
  return (!!e && e[1] >= 2 && e[0] / e[1] >= 0.5) || (!!s && s[1] >= 2 && s[0] / s[1] >= 0.5);
};

const segmentUnits = (m: LearntNames, units: string[]): string[][] => {
  const out: string[][] = [];
  let cur: string[] = [];
  units.forEach((u, i) => {
    if (i > 0 && boundary(m, units[i - 1], u)) {
      out.push(cur);
      cur = [];
    }
    cur.push(u);
  });
  if (cur.length) out.push(cur);
  return out;
};

const unitsKey = (units: string[]) => units.map(matchKey).join(" ");

export const learnJoinedNames = (texts: unknown[]): LearntNames => {
  const m: LearntNames = { pairs: new Map(), notEnd: new Map(), notStart: new Map(), ends: new Map(), starts: new Map(), names: new Set(), maxUnits: 1 };
  const all = texts.filter((t): t is string => typeof t === "string" && !!t.trim()).map(learntUnits);
  const counts = new Map<string, number>();
  for (const u of all)
    u.forEach((w, i) => {
      bump(counts, matchKey(w));
      if (i + 1 < u.length) {
        bump(m.pairs, pairKey(w, u[i + 1]));
        bump(m.notEnd, matchKey(w));
        bump(m.notStart, matchKey(u[i + 1]));
      }
    });
  // where the clear pairs put boundaries: how often a word ends / starts a name
  for (const u of all)
    u.forEach((w, i) => {
      if (i === 0) bumpRate(m.starts, matchKey(w), true);
      if (i === u.length - 1) bumpRate(m.ends, matchKey(w), true);
      if (i + 1 < u.length) {
        const rule = pairRule(m, w, u[i + 1]);
        if (rule) {
          bumpRate(m.ends, matchKey(w), rule === "cut");
          bumpRate(m.starts, matchKey(u[i + 1]), rule === "cut");
        }
      }
    });
  // the segments, counted: one seen twice or more is a name of the file
  // (a single word only when it mostly stands alone)
  const seen = new Map<string, { n: number; units: number; first: string }>();
  for (const u of all)
    for (const s of segmentUnits(m, u)) {
      const k = unitsKey(s);
      const cur = seen.get(k) || { n: 0, units: s.length, first: matchKey(s[0]) };
      cur.n++;
      seen.set(k, cur);
    }
  const names = new Set<string>();
  const repeated = new Set<string>();
  for (const [k, v] of seen) {
    if (v.n >= 2) repeated.add(k);
    if (v.n >= 2 && (v.units > 1 || v.n >= 0.6 * (counts.get(v.first) || 0))) names.add(k);
  }
  // a "name" made of two repeated segments is two names that happened to be
  // listed together
  const coveredByRepeated = (parts: string[]) => {
    const ok: boolean[] = [true];
    for (let j = 1; j <= parts.length; j++)
      ok[j] = Array.from({ length: j }, (_, i) => i).some((i) => ok[i] && !(i === 0 && j === parts.length) && repeated.has(parts.slice(i, j).join(" ")));
    return ok[parts.length];
  };
  for (const k of [...names]) if (k.includes(" ") && coveredByRepeated(k.split(" "))) names.delete(k);
  m.names = names;
  m.maxUnits = Math.min(12, Math.max(1, ...[...names].map((k) => k.split(" ").length)));
  return m;
};

// a joined list -> the names in it: the catalogue's and the file's names
// first (covering the most words with the fewest names), what is still left
// by the boundaries. The same file splits the same way on every run, so a
// second run finds the names the first one added.
export const splitLearnt = (text: unknown, m: LearntNames, catalogue?: CatalogIndex): string[] => {
  if (typeof text !== "string" || !text.trim()) return [];
  const units = learntUnits(text);
  const n = units.length;
  const maxUnits = Math.max(m.maxUnits, catalogue ? Math.min(12, catalogue.maxWords + 2) : 1);
  const isKnown = (slice: string[]) => m.names.has(unitsKey(slice)) || (!!catalogue && catalogue.byKey.has(matchKey(slice.join(" "))));
  type Best = { covered: number; parts: number; path: { units: string[]; known: boolean }[] };
  const best: (Best | undefined)[] = new Array(n + 1);
  best[0] = { covered: 0, parts: 0, path: [] };
  for (let i = 0; i < n; i++) {
    const b = best[i];
    if (!b) continue;
    for (let j = i + 1; j <= Math.min(n, i + maxUnits); j++) {
      const slice = units.slice(i, j);
      const known = isKnown(slice);
      if (!known && j > i + 1) continue;
      const cand: Best = { covered: b.covered + (known ? j - i : 0), parts: b.parts + 1, path: [...b.path, { units: slice, known }] };
      const cur = best[j];
      if (!cur || cand.covered > cur.covered || (cand.covered === cur.covered && cand.parts < cur.parts)) best[j] = cand;
    }
  }
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) for (const s of segmentUnits(m, run)) out.push(s.join(" "));
    run = [];
  };
  for (const p of best[n]?.path || []) {
    if (p.known) {
      flush();
      out.push(p.units.join(" "));
    } else run.push(...p.units);
  }
  flush();
  return out.map((s) => s.trim()).filter((s) => matchKey(s).length >= 2);
};

// ------------------------------------------------------------ speciality titles

export type SpecialityLevel = "general" | "specialist" | "subspecialist" | "fellowship";
export type SpecialityPart = { name: string; level?: SpecialityLevel; raw: string };

const LEVEL_PREFIX: [RegExp, SpecialityLevel | undefined][] = [
  [/^فوق[\s‌]*تخصص(?:ی)?\s+/, "subspecialist"],
  [/^فلوشیپ\s+/, "fellowship"],
  [/^(?:دکترای\s+تخصصی|دکتری\s+تخصصی|phd)\s+/i, "specialist"],
  [/^(?:تخصص|متخصص)\s+/, "specialist"],
  [/^(?:دکترای\s+حرفه[\s‌]*ای|پزشک\s+عمومی)\s*/, "general"],
  [/^(?:کارشناس\s+ارشد|کارشناسی\s+ارشد|کارشناس|دکترای|دکتری)\s+/, undefined],
];

// «تخصص زنان و زایمان-فلوشیپ ناباروری» -> [{زنان و زایمان, specialist},
// {ناباروری, fellowship}]
export const parseSpecialityTitle = (value: unknown): SpecialityPart[] => {
  if (typeof value !== "string") return [];
  const parts = faLetters(value)
    .replace(ZWNJ, "‌")
    .split(/\s*[-–—|/،,]\s*(?=\S)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: SpecialityPart[] = [];
  for (const raw of parts) {
    let name = raw;
    let level: SpecialityLevel | undefined;
    for (const [re, l] of LEVEL_PREFIX) {
      if (re.test(name)) {
        level = l;
        name = level === "general" && !name.replace(re, "").trim() ? "پزشک عمومی" : name.replace(re, "").trim();
        break;
      }
    }
    if (!name) continue;
    if (!out.some((o) => matchKey(o.name) === matchKey(name))) out.push({ name, level, raw });
  }
  return out;
};

// the names a speciality may be written as: without the parentheses, the
// word in parentheses in place of the word before it
export const nameVariants = (name: string): string[] => {
  const out = new Set<string>([name]);
  const noParen = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParen) out.add(noParen);
  const m = /^(.*?)(\S+)\s*\(([^)]+)\)(.*)$/.exec(name);
  if (m) out.add(`${m[1]}${m[3]}${m[4]}`.replace(/\s+/g, " ").trim());
  return [...out];
};

// how alike two names are (0..1): shared words, else shared letter pairs
export const similarity = (a: string, b: string) => {
  const wa = new Set(faLetters(a).replace(ZWNJ, " ").split(/[\s()]+/).map(matchKey).filter((w) => w.length > 1 && w !== "و"));
  const wb = new Set(faLetters(b).replace(ZWNJ, " ").split(/[\s()]+/).map(matchKey).filter((w) => w.length > 1 && w !== "و"));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const words = wa.size && wb.size ? inter / Math.max(wa.size, wb.size) : 0;
  const pairs = (s: string) => {
    const k = matchKey(s);
    const out: string[] = [];
    for (let i = 0; i < k.length - 1; i++) out.push(k.slice(i, i + 2));
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  const pbCount = new Map<string, number>();
  for (const p of pb) pbCount.set(p, (pbCount.get(p) || 0) + 1);
  let common = 0;
  for (const p of pa) {
    const c = pbCount.get(p) || 0;
    if (c) {
      common++;
      pbCount.set(p, c - 1);
    }
  }
  const dice = pa.length + pb.length ? (2 * common) / (pa.length + pb.length) : 0;
  return Math.max(words, dice);
};
