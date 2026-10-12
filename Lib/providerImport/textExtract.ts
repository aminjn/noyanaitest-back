// Bulk provider import: reading facts out of free text (2026-10, the DrDr
// data-exchange contract). Partner directories hand over one long
// "introduction" per doctor that holds the council number, the office
// hours, the insurers, an Instagram handle and the partner's own booking
// promotion, plus lists written as names joined by spaces with no
// separator. Everything here is pure (no database): the catalogue lookups
// that need one live in Services/providerImport.ts and pass their index in.

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

// a phrase as a forgiving regex: any space or half-space between words, ی/ي
// and ک/ك alike
export const phraseRegex = (phrase: string, flags = "g") => {
  const body = faLetters(phrase.trim())
    .replace(ZWNJ, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/ی/g, "[یيى]")
        .replace(/ک/g, "[کك]")
        .replace(/ا/g, "[اآأ]"),
    )
    .join("[\\s\\u200c]*");
  return new RegExp(body, flags);
};

const anyPhrase = (text: string, phrases: string[]) => phrases.some((p) => p.trim() && phraseRegex(p, "i").test(text));

// ------------------------------------------------------------ simple facts

// «کد نظام پزشکی 137448», «شماره نظام‌پزشکی ۱۳۷۴۴۸», «نظام پزشکی: ۱۲۳۴۵»
const COUNCIL = /(?:کد|شماره|ش\.)\s*(?:عضویت\s*)?(?:سازمان\s*)?نظام[\s‌]*(?:پزشکی|پ\.?)?\s*(?:ایشان\s*)?[:：]?\s*(?:#\s*)?(\d{3,7})(?!\d)/g;
export const extractCouncilNumbers = (text: unknown): string[] => {
  if (typeof text !== "string") return [];
  const t = latin(faLetters(text));
  const out: string[] = [];
  for (const m of t.matchAll(COUNCIL)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};

// an Instagram handle named in the text («... اینستاگرام ایشان به آدرس dr.x»)
export const extractInstagram = (text: unknown): string | undefined => {
  if (typeof text !== "string") return undefined;
  const t = faLetters(text);
  const url = /instagram\.com\/([A-Za-z0-9._]{2,30})/i.exec(t);
  const near =
    url ||
    /(?:اینستاگرام|اینستا|instagram)[^.!؟\n]{0,140}?(?:آدرس|نشانی|آیدی|ایدی|شناسه|پیج|صفحه|id)?\s*[:：]?\s*@?([A-Za-z][A-Za-z0-9._]{2,29})/i.exec(t);
  const handle = near?.[1]?.replace(/\.+$/, "");
  if (!handle || !/[A-Za-z]/.test(handle) || /^(instagram|www|http|https|com)$/i.test(handle)) return undefined;
  return handle;
};

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

// ------------------------------------------------------------ bio cleanup

export type BioOptions = {
  // sentences holding one of these are dropped (the partner's booking promo)
  dropPhrases?: string[];
  // a heading that starts a section dropped up to the next heading (reviews
  // copied from the partner, address, hours, insurers - each has its own
  // field, the partner's booking how-to)
  dropSections?: string[];
  // headings of the sections kept (they only mark where a section starts)
  keepSections?: string[];
};

const SENTENCE_END = /(?<=[.!؟?])\s+/;

export const cleanBio = (text: unknown, opts: BioOptions = {}, facts: { phone?: string; address?: string } = {}): string | undefined => {
  if (typeof text !== "string" || !text.trim()) return undefined;
  let t = faLetters(text).replace(/\r/g, "");
  // the partner's header: «درباره دکتر X تخصص Y کد نظام پزشکی 123»
  t = t.replace(/^\s*درباره\s+[^.!؟\n]{0,160}?(?:کد|شماره)\s*نظام[\s‌]*پزشکی\s*[:：]?\s*[\d۰-۹]+\s*/, "");
  // sections: every heading's position, then the dropped ones cut out
  type Mark = { at: number; drop: boolean };
  const marks: Mark[] = [];
  const mark = (list: string[] | undefined, drop: boolean) => {
    for (const p of list || []) {
      if (!p.trim()) continue;
      for (const m of t.matchAll(phraseRegex(p, "gi"))) marks.push({ at: m.index ?? 0, drop });
    }
  };
  mark(opts.dropSections, true);
  mark(opts.keepSections, false);
  marks.sort((a, b) => a.at - b.at || Number(b.drop) - Number(a.drop));
  if (marks.length) {
    let out = t.slice(0, marks[0].at);
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      // the same spot named by two headings counts once
      if (i > 0 && marks[i - 1].at === m.at) continue;
      const next = marks.slice(i + 1).find((x) => x.at > m.at)?.at ?? t.length;
      // «سوابق تحصیلی و افتخارات»: two headings of one section, one break
      const joined = i > 0 && !marks[i - 1].drop && !m.drop && m.at - marks[i - 1].at < 70;
      if (!m.drop) out += joined ? t.slice(m.at, next) : `\n\n${t.slice(m.at, next)}`;
    }
    t = out;
  }
  const phone = facts.phone ? latin(facts.phone).replace(/\D/g, "") : "";
  // the street part of the address («بلوار طالقانی»): a sentence repeating
  // it is the address again
  const street = typeof facts.address === "string" ? matchKey(faLetters(facts.address).split(/\s*-\s*/).pop()!.split(/[،,]/)[0]) : "";
  const paragraphs = t
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split(SENTENCE_END)
        .filter((s) => {
          if (anyPhrase(s, opts.dropPhrases || [])) return false;
          // the phone and the address are fields of their own
          if (phone && phone.length >= 7 && latin(s).replace(/\D/g, "").includes(phone)) return false;
          if (street.length >= 8 && matchKey(s).includes(street)) return false;
          // a bare insurer name left at the end («بیمه دی»)
          if (/^بیمه\s+\S+(\s+\S+)?\s*$/.test(s.trim())) return false;
          return true;
        })
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .map((p) => p.replace(/^[\s.،,:؛-]+/, ""))
    .filter((p) => p.length > 1);
  const out = paragraphs.join("\n\n").trim();
  return out || undefined;
};

// the part of the text after one of these headings, up to ~600 characters
export const sectionAfter = (text: string, headings: string[], size = 600): string[] => {
  const out: string[] = [];
  for (const h of headings)
    for (const m of faLetters(text).matchAll(phraseRegex(h, "gi"))) out.push(faLetters(text).slice(m.index ?? 0, (m.index ?? 0) + size));
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

// the hours paragraph(s) of a bio: after «ساعت کاری / ساعت کار مطب / ...»
export const HOURS_HEADINGS = ["ساعت کاری", "ساعت کار مطب", "ساعات کاری", "ساعت حضور", "روزهای کاری", "ساعات حضور", "ساعت های کاری"];
export const hoursText = (text: unknown): string | undefined => {
  if (typeof text !== "string") return undefined;
  const parts = sectionAfter(text, HOURS_HEADINGS, 320);
  return parts.length ? parts.join(" | ") : undefined;
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
  let lastEnd = -2;
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
    // one word left between two names («زگیل تناسلی زنان»): a qualifier of
    // the name before it, not a name of its own
    if (pending.length === 1 && matched.length && lastEnd === i - 2 && !/^(و|یا|،)$/.test(pending[0]) && matchKey(pending[0]).length >= 3) pending = [];
    flush();
    let end = hit.end;
    const source = [units.slice(i, end).map((u) => u.text).join(" ")];
    // its explanation in parentheses goes with it
    while (units[end]?.paren) source.push(units[end++].text);
    if (!matched.some((m) => m.id === hit!.entry.id)) matched.push({ ...hit.entry, source: source.join(" ") });
    i = end;
    lastEnd = end - 1;
  }
  // a last single qualifier word after a name
  if (pending.length === 1 && matched.length && lastEnd === units.length - 2 && matchKey(pending[0]).length >= 3 && !/^(و|یا)$/.test(pending[0])) pending = [];
  flush();
  return { matched, leftovers: leftovers.filter((l) => matchKey(l).length >= 2) };
};

// catalogue names found in running text, each preceded by «بیمه» (or in a
// list after «طرف قرارداد»): the insurers a doctor accepts
export const findNamesInText = (text: unknown, rows: { id: string; name: string; aliases?: string[] }[], lead = /^بیمه/): CatalogEntry[] => {
  if (typeof text !== "string" || !text.trim()) return [];
  const words = faLetters(text).replace(ZWNJ, " ").split(/[\s،,.:؛()«»]+/).filter(Boolean);
  const keys = words.map(matchKey);
  const out: CatalogEntry[] = [];
  for (const r of rows) {
    for (const n of [r.name, ...(r.aliases || [])]) {
      const nameWords = faLetters(n).replace(ZWNJ, " ").split(/\s+/).filter(Boolean).map(matchKey);
      // «بیمه سلامت» is matched as «سلامت» after a «بیمه»
      const core = nameWords[0] && lead.test(nameWords[0]) && nameWords.length > 1 ? nameWords.slice(1) : nameWords;
      if (!core.length) continue;
      let found = false;
      for (let i = 0; i + core.length <= keys.length && !found; i++) {
        if (core.every((k, j) => keys[i + j] === k)) {
          const before = keys.slice(Math.max(0, i - 3), i);
          if (before.some((b) => lead.test(b))) found = true;
        }
      }
      if (found && !out.some((o) => o.id === r.id)) out.push({ id: r.id, name: r.name });
      if (found) break;
    }
  }
  return out;
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
