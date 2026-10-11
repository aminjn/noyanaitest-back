import { z } from "zod";
import { locales } from "../locales";
import {
  AnyKind,
  FieldType,
  genders,
  kindChildren,
  kindFields,
  samplings,
  TargetField,
  visitTypes,
  weekDays,
} from "./catalog";
import { isEmptyValue, latinDigits, MappedRecord, normalizePhoneText, valueKey } from "./mapping";

// Bulk provider import: one mapped record -> a clean, typed record of our
// format, or the reasons it is not one (2026-10). Each field is coerced by
// its type (digits, phones, days, times, enums with their usual Persian /
// English spellings) inside a zod schema built from the catalogue, so the
// preview, the dry run and the real run report the same problems, each
// with the path of the record and the field.
//
// Issue texts are Persian admin texts with ${n} placeholders: the panel
// shows them through ta() (Components/Admin/i18n/dict/*.json).

export type IssueLevel = "error" | "warning";
export type Issue = { level: IssueLevel; path: string; field?: string; code: string; params?: string[] };

export const ISSUE = {
  required: "این فیلد لازم است",
  invalid: "مقدار «${1}» معتبر نیست",
  gender: "جنسیت «${1}» شناخته نشد",
  visitType: "نوع ویزیت «${1}» شناخته نشد",
  sampling: "نوع نمونه‌گیری «${1}» شناخته نشد",
  day: "روز «${1}» شناخته نشد",
  time: "ساعت «${1}» معتبر نیست",
  price: "قیمت باید عددی بزرگ‌تر از صفر باشد",
  phone: "شماره‌ی تلفن «${1}» معتبر نیست",
  url: "نشانی اینترنتی «${1}» معتبر نیست",
  lat: "عرض جغرافیایی باید عددی بین ۹۰- و ۹۰ باشد",
  lng: "طول جغرافیایی باید عددی بین ۱۸۰- و ۱۸۰ باشد",
  point: "مختصات «${1}» به شکل «عرض,طول» نیست",
  swapped: "عرض و طول جغرافیایی جابه‌جا بودند و درست شدند",
  endBeforeStart: "ساعت پایان باید بعد از ساعت شروع باشد",
  noName: "نام و نام خانوادگی پزشک لازم است",
  nameSplit: "نام کامل «${1}» به نام و نام خانوادگی جدا شد؛ بررسی کنید",
  noExternalId: "شناسه‌ی رکورد (externalId) لازم است",
  noHours: "ساعت شروع و پایان (یا بازه‌ی ساعت) لازم است",
  noPrice: "قیمت نوع ویزیت «${1}» لازم است",
  duplicateId: "شناسه‌ی «${1}» در این فایل تکراری است؛ ردیف اول وارد می‌شود",
  duplicateCode: "شماره‌ی نظام پزشکی «${1}» در این فایل تکراری است",
  childSkipped: "این ردیف کنار گذاشته شد",
  tooLong: "متن بیش از حد بلند است",
} as const;

export type CleanRecord = {
  kind: AnyKind;
  // where it is in the source, e.g. "data.items[3].clinics[0]"
  path: string;
  externalId?: string;
  data: Record<string, any>;
  translations: Record<string, Record<string, unknown>>;
  children: Record<string, CleanRecord[]>;
  issues: Issue[];
  ok: boolean;
};

// ------------------------------------------------------------ coercion

const norm = (s: string) => s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();
const text = (v: unknown) => (typeof v === "string" ? norm(v) : typeof v === "number" ? String(v) : undefined);
const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s || "").slice(0, 80);
};

const synonymsOf: Record<string, Record<string, string[]>> = {
  gender: {
    male: ["male", "m", "man", "men", "مرد", "آقا", "اقا", "مذکر", "1"],
    female: ["female", "f", "woman", "women", "زن", "خانم", "مونث", "مؤنث", "2"],
  },
  type: {
    inPerson: ["inperson", "inperson", "in-person", "office", "visit", "clinic", "presence", "حضوری", "ویزیتحضوری", "مطب"],
    videoCall: ["videocall", "video", "videovisit", "تصویری", "ویدیویی", "ویدئویی", "ویزیتتصویری"],
    textChat: ["textchat", "chat", "text", "message", "messaging", "متنی", "چت", "گفتگو", "مشاورهمتنی"],
    voiceCall: ["voicecall", "phone", "call", "voice", "telephone", "تلفنی", "صوتی", "تماس", "مشاورهتلفنی"],
  },
  sampling: {
    lab: ["lab", "inlab", "آزمایشگاه", "حضوری"],
    labOrHome: ["laborhome", "home", "homesampling", "both", "درمنزل", "منزل"],
    none: ["none", "no", "نیاز ندارد", "ندارد"],
  },
};

const enumOf = (field: string, allowed: readonly string[], v: unknown): string | undefined => {
  const key = valueKey(v);
  const direct = allowed.find((a) => valueKey(a) === key);
  if (direct) return direct;
  const syn = synonymsOf[field] || {};
  for (const [value, names] of Object.entries(syn)) if (names.map(valueKey).includes(key)) return value;
  return undefined;
};

const DAY_NAMES: string[][] = [
  ["saturday", "sat", "شنبه", "6"],
  ["sunday", "sun", "یکشنبه", "یک‌شنبه", "0"],
  ["monday", "mon", "دوشنبه", "1"],
  ["tuesday", "tue", "tues", "سهشنبه", "سه‌شنبه", "2"],
  ["wednesday", "wed", "چهارشنبه", "3"],
  ["thursday", "thu", "thur", "thurs", "پنجشنبه", "پنج‌شنبه", "4"],
  ["friday", "fri", "جمعه", "5"],
];
// a number is the Iranian week (0 = Saturday) unless written as a JS day
// name; the documented format uses the names
export const dayOf = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  const key = valueKey(v);
  if (/^[0-6]$/.test(key)) return Number(key);
  const i = DAY_NAMES.findIndex((names) => names.slice(0, -1).map(valueKey).includes(key));
  return i === -1 ? undefined : i;
};

export const minutesOfTime = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) {
    // 9 / 9.5 = hours; 540 = minutes
    if (v <= 24) return Math.round(v * 60);
    return v <= 1440 && Number.isInteger(v) ? v : undefined;
  }
  if (typeof v !== "string") return undefined;
  const s = latinDigits(v).trim().replace(/\s*(ق\.ظ|ب\.ظ|am|pm)$/i, (m) => ` ${m.toLowerCase()}`);
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm|ق\.ظ|ب\.ظ)?$/i.exec(s);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase();
  if ((ap === "pm" || ap === "ب.ظ") && h < 12) h += 12;
  if ((ap === "am" || ap === "ق.ظ") && h === 12) h = 0;
  if (h > 24 || min > 59 || (h === 24 && min)) return undefined;
  return h * 60 + min;
};

export const rangesOf = (v: unknown): { from: number; to: number }[] | undefined => {
  const parts = (Array.isArray(v) ? v : String(v ?? "").split(/[,،;]|\s+و\s+/))
    .map((p) => (typeof p === "string" ? latinDigits(p).trim() : p))
    .filter((p) => !isEmptyValue(p));
  const out: { from: number; to: number }[] = [];
  for (const p of parts) {
    const [a, b] = String(p).split(/\s*(?:-|–|—|تا|to)\s*/i);
    const from = minutesOfTime(a);
    const to = minutesOfTime(b);
    if (from === undefined || to === undefined) return undefined;
    out.push({ from, to });
  }
  return out.length ? out : undefined;
};

const listOf = (v: unknown): string[] => {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,،;|\n]/) : v === undefined || v === null ? [] : [v];
  const out: string[] = [];
  for (const item of items) {
    const t =
      item && typeof item === "object"
        ? text((item as Record<string, unknown>).name ?? (item as Record<string, unknown>).title ?? (item as Record<string, unknown>).fa)
        : text(item);
    if (t && !out.includes(t)) out.push(t.slice(0, 300));
  }
  return out;
};

const numberOf = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = latinDigits(v).replace(/[,\s]/g, "").replace(/(تومان|ریال|toman|rial)$/i, "");
  const n = Number(s);
  return s && Number.isFinite(n) ? n : undefined;
};

const boolOf = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  const key = valueKey(v);
  if (["true", "1", "yes", "y", "بله", "آری", "فعال", "دارد", "on"].map(valueKey).includes(key)) return true;
  if (["false", "0", "no", "n", "خیر", "نه", "غیرفعال", "ندارد", "off"].map(valueKey).includes(key)) return false;
  return undefined;
};

const phoneOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = normalizePhoneText(String(v));
  return /^98\d{10}$/.test(s) ? s : undefined;
};

const urlOf = (v: unknown): string | undefined => {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.includes(".") ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

// Iran sits at lat 24-40, lng 44-64: a pair given the other way round is
// recognisable
const inIran = (lat: number, lng: number) => lat >= 24 && lat <= 40.5 && lng >= 43 && lng <= 64;
export const pointOf = (v: unknown): { lat: number; lng: number; swapped?: boolean } | undefined => {
  let a: number | undefined;
  let b: number | undefined;
  if (Array.isArray(v)) [a, b] = [numberOf(v[0]), numberOf(v[1])];
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.coordinates)) return pointOf([o.coordinates[1], o.coordinates[0]]);
    [a, b] = [numberOf(o.lat ?? o.latitude), numberOf(o.lng ?? o.lon ?? o.longitude)];
  } else if (typeof v === "string") {
    const m = latinDigits(v).match(/-?\d+(?:\.\d+)?/g);
    if (m && m.length === 2) [a, b] = [Number(m[0]), Number(m[1])];
  }
  if (a === undefined || b === undefined || Math.abs(a) > 90 || Math.abs(b) > 180) {
    if (a !== undefined && b !== undefined && Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a, swapped: true };
    return undefined;
  }
  if (!inIran(a, b) && inIran(b, a)) return { lat: b, lng: a, swapped: true };
  return { lat: a, lng: b };
};

type Coerced = { value?: unknown; issue?: { code: string; params?: string[] }; translations?: Record<string, string> };

const coerce = (field: TargetField, v: unknown): Coerced => {
  const bad = (code: string = ISSUE.invalid) => ({ issue: { code, params: [show(v)] } });
  const t: FieldType = field.type;
  switch (t) {
    case "id":
    case "ref": {
      const s = text(v);
      return s ? { value: latinDigits(s).slice(0, 120) } : bad();
    }
    case "string": {
      const s = text(v);
      if (!s) return bad();
      return s.length > 500 ? { issue: { code: ISSUE.tooLong } } : { value: s };
    }
    case "text":
    case "i18n": {
      const translations: Record<string, string> = {};
      let fa: string | undefined;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [loc, val] of Object.entries(v as Record<string, unknown>)) {
          const s = text(val);
          if (!s || !(locales as readonly string[]).includes(loc)) continue;
          if (loc === "fa") fa = s;
          else translations[loc] = s;
        }
        fa ||= Object.values(translations)[0];
      } else fa = typeof v === "string" ? v.trim() : text(v);
      if (!fa) return bad();
      if (fa.length > 20000) return { issue: { code: ISSUE.tooLong } };
      return { value: fa.replace(/ي/g, "ی").replace(/ك/g, "ک"), translations };
    }
    case "number": {
      const n = numberOf(v);
      return n !== undefined && n >= 0 ? { value: n } : bad();
    }
    case "price": {
      const n = numberOf(v);
      return n !== undefined && n > 0 ? { value: Math.round(n) } : { issue: { code: ISSUE.price } };
    }
    case "boolean": {
      const b = boolOf(v);
      return b === undefined ? bad() : { value: b };
    }
    case "enum": {
      const e = enumOf(field.key, field.enum || [], v);
      const code = field.key === "gender" ? ISSUE.gender : field.key === "type" ? ISSUE.visitType : field.key === "sampling" ? ISSUE.sampling : ISSUE.invalid;
      return e ? { value: e } : bad(code);
    }
    case "list":
    case "refList": {
      const l = listOf(v);
      return l.length ? { value: field.type === "refList" ? l.map(latinDigits) : l } : bad();
    }
    case "url": {
      const u = urlOf(v);
      return u ? { value: u } : bad(ISSUE.url);
    }
    case "phone": {
      const p = phoneOf(Array.isArray(v) ? v[0] : v);
      return p ? { value: p } : bad(ISSUE.phone);
    }
    case "phoneList": {
      const list = (Array.isArray(v) ? v : String(v).split(/[,،;|\n]/)).filter((x) => !isEmptyValue(x));
      const ok = list.map(phoneOf);
      const badOne = list.find((_, i) => !ok[i]);
      if (badOne !== undefined) return { issue: { code: ISSUE.phone, params: [show(badOne)] } };
      return { value: [...new Set(ok as string[])] };
    }
    case "lat": {
      const n = numberOf(v);
      return n !== undefined && Math.abs(n) <= 90 ? { value: n } : { issue: { code: ISSUE.lat } };
    }
    case "lng": {
      const n = numberOf(v);
      return n !== undefined && Math.abs(n) <= 180 ? { value: n } : { issue: { code: ISSUE.lng } };
    }
    case "point": {
      const p = pointOf(v);
      return p ? { value: p } : bad(ISSUE.point);
    }
    case "day": {
      // one row may name several days ("شنبه, دوشنبه" or a list)
      const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,،;|]|\s+و\s+/) : [v];
      const days = items.filter((x) => !isEmptyValue(x)).map(dayOf);
      if (!days.length || days.some((d) => d === undefined)) return bad(ISSUE.day);
      return { value: [...new Set(days as number[])] };
    }
    case "time": {
      const m = minutesOfTime(v);
      return m === undefined ? bad(ISSUE.time) : { value: m };
    }
    case "timeRange": {
      const r = rangesOf(v);
      return r ? { value: r } : bad(ISSUE.time);
    }
  }
  return bad();
};

// zod runs the coercion field by field and collects every problem at once
const schemaFor = (kind: AnyKind) =>
  z.object(
    Object.fromEntries(
      kindFields[kind].map((field) => [
        field.key,
        z.optional(z.any()).transform((v, ctx) => {
          if (isEmptyValue(v)) return undefined;
          const r = coerce(field, v);
          if (r.issue) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.issue.code, params: { values: r.issue.params || [] } });
            return z.NEVER;
          }
          return r.translations && Object.keys(r.translations).length ? { __v: r.value, __t: r.translations } : r.value;
        }),
      ]),
    ),
  );
const schemas = new Map<AnyKind, ReturnType<typeof schemaFor>>();
const schemaOf = (kind: AnyKind) => {
  if (!schemas.has(kind)) schemas.set(kind, schemaFor(kind));
  return schemas.get(kind)!;
};

const TOP_LEVEL = new Set<AnyKind>(["doctor", "clinic", "hospital", "pharmacy", "lab", "insurer"]);

export const cleanRecord = (raw: MappedRecord, kind: AnyKind, path: string, parentId?: string, index = 0): CleanRecord => {
  const issues: Issue[] = [];
  const err = (code: string, field?: string, params?: string[]) => issues.push({ level: "error", path, field, code, params });
  const warn = (code: string, field?: string, params?: string[]) => issues.push({ level: "warning", path, field, code, params });
  const parsed = schemaOf(kind).safeParse(raw || {});
  const data: Record<string, any> = {};
  const translations: Record<string, Record<string, unknown>> = {};
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      const p = (issue as { params?: { values?: string[] } }).params;
      // a bad optional field is dropped with a warning; a bad required one fails the record
      const required = kindFields[kind].find((f) => f.key === field)?.required;
      (required ? err : warn)(issue.message, field, p?.values);
    }
  const values = (parsed.success ? parsed.data : {}) as Record<string, unknown>;
  // the failed parse still tells which fields were fine: parse them one by one
  const source = parsed.success
    ? values
    : Object.fromEntries(
        kindFields[kind].map((f) => {
          const one = schemaOf(kind).shape[f.key].safeParse((raw || {})[f.key]);
          return [f.key, one.success ? one.data : undefined];
        }),
      );
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && "__v" in (value as object)) {
      data[key] = (value as { __v: unknown }).__v;
      for (const [loc, t] of Object.entries((value as { __t: Record<string, string> }).__t)) (translations[loc] ||= {})[key] = t;
    } else data[key] = value;
  }
  // translations mapped as <field>@<locale> or given in the file
  const extra = raw?.translations;
  if (extra && typeof extra === "object")
    for (const [loc, bag] of Object.entries(extra)) {
      if (!(locales as readonly string[]).includes(loc) || loc === "fa" || !bag || typeof bag !== "object") continue;
      for (const [field, val] of Object.entries(bag as Record<string, unknown>)) {
        const def = kindFields[kind].find((f) => f.key === field);
        const s = typeof val === "string" ? val.trim() : Array.isArray(val) ? val : undefined;
        if (def && s && (def.type === "i18n" || def.type === "string" || def.type === "list")) (translations[loc] ||= {})[field] = s;
      }
    }

  // the point of a "lat,lng" text, or lat + lng
  if (data.point && (data.lat === undefined || data.lng === undefined)) {
    if (data.point.swapped) warn(ISSUE.swapped, "point");
    data.lat = data.point.lat;
    data.lng = data.point.lng;
  }
  delete data.point;
  if ((data.lat === undefined) !== (data.lng === undefined)) {
    warn(data.lat === undefined ? ISSUE.lat : ISSUE.lng, data.lat === undefined ? "lat" : "lng");
    delete data.lat;
    delete data.lng;
  } else if (data.lat !== undefined && !inIran(data.lat, data.lng) && inIran(data.lng, data.lat)) {
    [data.lat, data.lng] = [data.lng, data.lat];
    warn(ISSUE.swapped, "lat");
  }

  // kind rules
  let externalId: string | undefined = data.externalId;
  if (kind === "doctor") {
    if ((!data.firstName || !data.lastName) && data.fullName) {
      const words = String(data.fullName)
        .replace(/^\s*(دکتر|Dr\.?|Doctor)\s+/i, "")
        .split(" ")
        .filter(Boolean);
      if (words.length >= 2) {
        data.firstName ||= words[0];
        data.lastName ||= words.slice(1).join(" ");
        warn(ISSUE.nameSplit, "fullName", [String(data.fullName)]);
      }
    }
    delete data.fullName;
    if (!data.firstName || !data.lastName) {
      if (!issues.some((i) => i.field === "firstName" || i.field === "lastName")) err(ISSUE.noName, "firstName");
    }
    if (data.medicalCode) data.medicalCode = latinDigits(String(data.medicalCode)).replace(/\s+/g, "");
    if (data.mainSpeciality && !data.specialities?.includes(data.mainSpeciality))
      data.specialities = [data.mainSpeciality, ...(data.specialities || [])];
    if (!data.mainSpeciality && data.specialities?.length) data.mainSpeciality = data.specialities[0];
  }
  if (kind === "office") {
    externalId ||= parentId ? `${parentId}#${index + 1}` : undefined;
    if (!parentId && !data.doctor) err(ISSUE.required, "doctor");
  }
  if (kind === "hours") {
    const ranges = data.range || (data.from !== undefined && data.to !== undefined ? [{ from: data.from, to: data.to }] : null);
    if (!ranges) err(ISSUE.noHours, data.from === undefined ? "from" : "to");
    else data.ranges = ranges;
    delete data.range;
    delete data.from;
    delete data.to;
    if (data.visitTypes)
      data.visitTypes = (data.visitTypes as string[]).map((v) => enumOf("type", visitTypes, v)).filter(Boolean);
    if (data.slotMinutes !== undefined && (data.slotMinutes < 5 || data.slotMinutes > 480)) {
      warn(ISSUE.invalid, "slotMinutes", [String(data.slotMinutes)]);
      delete data.slotMinutes;
    }
  }
  if (kind === "visitType" && data.duration !== undefined && (data.duration < 5 || data.duration > 480)) {
    warn(ISSUE.invalid, "duration", [String(data.duration)]);
    delete data.duration;
  }
  if (TOP_LEVEL.has(kind) && !externalId && !issues.some((i) => i.field === "externalId")) err(ISSUE.noExternalId, "externalId");
  for (const f of kindFields[kind])
    if (
      f.required &&
      f.key !== "externalId" &&
      !(kind === "doctor" && (f.key === "firstName" || f.key === "lastName")) &&
      data[f.key] === undefined &&
      !issues.some((i) => i.field === f.key)
    )
      err(ISSUE.required, f.key);
  if (kind === "lab" && data.sampling === undefined) delete data.sampling;
  if (data.slug) data.slug = String(data.slug).trim().toLowerCase();

  // children
  const children: Record<string, CleanRecord[]> = {};
  for (const spec of kindChildren[kind]) {
    const list = raw?.[spec.key];
    if (!Array.isArray(list)) continue;
    children[spec.key] = list.map((item, i) =>
      cleanRecord(item as MappedRecord, spec.kind, `${path}.${spec.key}[${i}]`, externalId, i),
    );
  }
  return {
    kind,
    path,
    externalId,
    data,
    translations,
    children,
    issues,
    ok: !issues.some((i) => i.level === "error"),
  };
};

// every issue of a record and its children
export const allIssues = (r: CleanRecord): Issue[] => [
  ...r.issues,
  ...Object.values(r.children).flatMap((list) => list.flatMap(allIssues)),
];

export { weekDays, genders, samplings };
