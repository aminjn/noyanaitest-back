import mongoose from "mongoose";
import AppError from "./AppError";
import { addDaysYmd, DateLike, tehranParts, tehranSaturdayDay } from "./tehranTime";

// Structured weekly opening hours (2026-10, owner's decision) for
// pharmacies, labs, clinics and hospitals: "open now", "closes at 22:00",
// "opens tomorrow 08:00", the "open now" filter of the lists and the
// openingHoursSpecification of the SEO resolver all read this one model.
//
// - days: 7 entries, 0 = Saturday ... 6 = Friday (the Iranian week, as a
//   doctor shift's day). A day with no range is closed. A range is minutes
//   since Tehran midnight: start 0-1439, end 1-1440; end < start runs past
//   midnight (20:00-02:00 is { start: 1200, end: 120 }). 00:00-24:00 is the
//   whole day.
// - exceptions: a Tehran "YYYY-MM-DD" day (a holiday, a closed day) whose
//   ranges replace that weekday's; no range = closed all day.
// - weekIntervals: derived on save, [s, e) minutes of the week from
//   Saturday 00:00, overnight and Friday-to-Saturday ranges split, so a
//   list can pre-filter "open now" in Mongo before the exact check.
// - no days at all = the centre never gave its hours (no badge, never in
//   the "open now" list).
//
// The round-the-clock flag (isRoundTheClock) is the same fact: true <=>
// every day is 00:00-24:00 (openingHoursPlugin keeps both in step). The
// old free-text hours (businessTime / businessTimes) stay as a note.

export const DAY_MINUTES = 1440;
export const WEEK_MINUTES = 7 * DAY_MINUTES;
const MAX_RANGES_PER_DAY = 4;
const MAX_EXCEPTIONS = 60;
// exceptions older than this are dropped on save
const KEEP_PAST_EXCEPTION_DAYS = 7;
// how far ahead "opens on ..." looks (a long closure ends after it)
const LOOKAHEAD_DAYS = 14;

export type HoursRange = { start: number; end: number };
export type HoursDay = { ranges: HoursRange[] };
export type HoursException = { date: string; ranges: HoursRange[] };
export type OpeningHours = {
  days: HoursDay[];
  exceptions: HoursException[];
  weekIntervals?: { s: number; e: number }[];
};

const rangeSchema = new mongoose.Schema<HoursRange>(
  {
    start: { type: Number, min: 0, max: DAY_MINUTES - 1, required: true },
    end: { type: Number, min: 1, max: DAY_MINUTES, required: true },
  },
  { _id: false },
);

export const openingHoursSchema = new mongoose.Schema<OpeningHours>(
  {
    days: { type: [new mongoose.Schema<HoursDay>({ ranges: { type: [rangeSchema], default: [] } }, { _id: false })], default: [] },
    exceptions: {
      type: [
        new mongoose.Schema<HoursException>(
          {
            date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
            ranges: { type: [rangeSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    weekIntervals: {
      type: [new mongoose.Schema({ s: Number, e: Number }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

// ------------------------------------------------------------ parsing

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(\d{1,2})(?::(\d{2}))?$/;

// minutes of a "HH:MM" text or a number; 24:00 is 1440
const minutesOf = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= DAY_MINUTES ? v : null;
  if (typeof v !== "string") return null;
  const m = HHMM.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
};

// a valid range or null (start 24:00 is never valid, start == end is empty)
const rangeOf = (v: unknown): HoursRange | null => {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const start = minutesOf(r.start);
  let end = minutesOf(r.end);
  if (start === null || end === null || start >= DAY_MINUTES) return null;
  // 22:00-00:00 means "till midnight"
  if (end === 0) end = DAY_MINUTES;
  if (start === end) return null;
  return { start, end };
};

// a day's ranges sorted, the overlapping / touching ones joined; an
// overnight range is kept as is (it is joined with the next day when read)
const cleanRanges = (list: unknown): HoursRange[] | null => {
  if (!Array.isArray(list)) return [];
  const ranges: HoursRange[] = [];
  for (const item of list) {
    const r = rangeOf(item);
    if (!r) return null;
    ranges.push(r);
  }
  if (ranges.length > MAX_RANGES_PER_DAY) return null;
  const sameDay = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const overnight = ranges.filter((r) => r.end < r.start);
  // at most one range may run past midnight, and it starts after the others
  if (overnight.length > 1) return null;
  const merged: HoursRange[] = [];
  for (const r of sameDay) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  if (!overnight.length) return merged;
  // 08:00-14:00 + 12:00-02:00 = 08:00-02:00: what overlaps the overnight
  // range on this day joins it
  const o = { ...overnight[0] };
  const kept: HoursRange[] = [];
  for (const r of merged) {
    if (r.end >= o.start) o.start = Math.min(o.start, r.start);
    else kept.push(r);
  }
  return [...kept, o];
};

export const OPENING_HOURS_ERROR =
  "ساعات کاری درست وارد نشده است؛ هر بازه شروع و پایان دارد، هر روز حداکثر چهار بازه و یک بازه شبانه";
export class OpeningHoursError extends AppError {
  constructor(public reason: string) {
    super(OPENING_HOURS_ERROR, 400);
  }
}

// What a client sent (JSON object or string) as stored hours; null clears
// them (no hours given). Throws OpeningHoursError on a malformed value.
export const normalizeOpeningHours = (input: unknown, now: Date = new Date()): OpeningHours | null => {
  let raw = input;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new OpeningHoursError("bad json");
    }
  }
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OpeningHoursError("bad shape");
  const src = raw as { days?: unknown; exceptions?: unknown };
  const daysIn = Array.isArray(src.days) ? src.days : [];
  if (daysIn.length !== 0 && daysIn.length !== 7) throw new OpeningHoursError("need 7 days");
  const days: HoursDay[] = [];
  for (const d of daysIn) {
    const ranges = cleanRanges(d && typeof d === "object" ? (d as { ranges?: unknown }).ranges : []);
    if (!ranges) throw new OpeningHoursError("bad range");
    days.push({ ranges });
  }
  const exIn = Array.isArray(src.exceptions) ? src.exceptions : [];
  const oldest = addDaysYmd(tehranParts(now).ymd, -KEEP_PAST_EXCEPTION_DAYS);
  const byDate = new Map<string, HoursException>();
  for (const e of exIn) {
    if (!e || typeof e !== "object") throw new OpeningHoursError("bad exception");
    const ex = e as { date?: unknown; ranges?: unknown };
    const date = typeof ex.date === "string" ? ex.date.trim().slice(0, 10) : "";
    if (!YMD.test(date)) throw new OpeningHoursError("bad exception date");
    const ranges = cleanRanges(ex.ranges);
    if (!ranges) throw new OpeningHoursError("bad range");
    if (date < oldest) continue;
    byDate.set(date, { date, ranges });
  }
  const exceptions = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (exceptions.length > MAX_EXCEPTIONS) throw new OpeningHoursError("too many exceptions");
  if (!days.length && !exceptions.length) return null;
  return { days, exceptions, weekIntervals: weekIntervalsOf(days) };
};

// ------------------------------------------------------------ derived

export const hasWeeklyHours = (h: unknown): h is OpeningHours =>
  !!h && typeof h === "object" && Array.isArray((h as OpeningHours).days) && (h as OpeningHours).days.length === 7;

const fullDay = (d?: HoursDay) =>
  !!d && Array.isArray(d.ranges) && d.ranges.some((r) => r.start === 0 && r.end === DAY_MINUTES);

// every day 00:00-24:00: what "round the clock" means
export const isRoundTheClockHours = (h: unknown) => hasWeeklyHours(h) && h.days.every(fullDay);

export const roundTheClockDays = (): HoursDay[] =>
  Array.from({ length: 7 }, () => ({ ranges: [{ start: 0, end: DAY_MINUTES }] }));

// [s, e) minutes of the week from Saturday 00:00
export const weekIntervalsOf = (days: HoursDay[]) => {
  const out: { s: number; e: number }[] = [];
  days.forEach((d, i) => {
    for (const r of Array.isArray(d?.ranges) ? d.ranges : []) {
      const s = i * DAY_MINUTES + r.start;
      const e = i * DAY_MINUTES + (r.end > r.start ? r.end : r.end + DAY_MINUTES);
      if (e <= WEEK_MINUTES) out.push({ s, e });
      else out.push({ s, e: WEEK_MINUTES }, { s: 0, e: e - WEEK_MINUTES });
    }
  });
  return out.sort((a, b) => a.s - b.s);
};

// minutes of the week (from Saturday 00:00) of an instant, in Tehran
export const tehranWeekMinute = (at: DateLike = new Date()) =>
  tehranSaturdayDay(at) * DAY_MINUTES + tehranParts(at).minutes;

// ------------------------------------------------------------ reading

const rangesOn = (h: OpeningHours, ymd: string, satDay: number): HoursRange[] => {
  const ex = Array.isArray(h.exceptions) ? h.exceptions.find((e) => e?.date === ymd) : undefined;
  if (ex) return Array.isArray(ex.ranges) ? ex.ranges : [];
  if (!hasWeeklyHours(h)) return [];
  const d = h.days[((satDay % 7) + 7) % 7];
  return Array.isArray(d?.ranges) ? d.ranges : [];
};

// the open intervals from `fromDay` to `toDay` days around today, in
// minutes from today's Tehran midnight, joined where they touch
const intervalsAround = (h: OpeningHours, at: DateLike, fromDay: number, toDay: number) => {
  const p = tehranParts(at);
  const today = tehranSaturdayDay(at);
  const list: { s: number; e: number }[] = [];
  for (let d = fromDay; d <= toDay; d++) {
    for (const r of rangesOn(h, addDaysYmd(p.ymd, d), today + d)) {
      if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
      const base = d * DAY_MINUTES;
      list.push({ s: base + r.start, e: base + (r.end > r.start ? r.end : r.end + DAY_MINUTES) });
    }
  }
  list.sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [];
  for (const i of list) {
    const last = merged[merged.length - 1];
    if (last && i.s <= last.e) last.e = Math.max(last.e, i.e);
    else merged.push({ ...i });
  }
  return { merged, now: p.minutes, today };
};

const hasAnyHours = (h: unknown): h is OpeningHours =>
  !!h &&
  typeof h === "object" &&
  (hasWeeklyHours(h) || (Array.isArray((h as OpeningHours).exceptions) && (h as OpeningHours).exceptions.length > 0));

// Is the centre open at an instant (Tehran wall clock)? false when it gave
// no hours.
export const isOpenAt = (hours: unknown, at: DateLike = new Date()) => {
  if (!hasAnyHours(hours)) return false;
  const { merged, now } = intervalsAround(hours, at, -1, 0);
  return merged.some((i) => i.s <= now && now < i.e);
};

export type OpenMoment = {
  // days after today (0 today, 1 tomorrow ...)
  dayOffset: number;
  // minutes since that day's midnight; 1440 = 24:00
  minutes: number;
  // 0 = Saturday ... 6 = Friday
  day: number;
};
export type OpenStatus = {
  open: boolean;
  // open with no closing in the next two weeks (round the clock)
  allDay?: boolean;
  closesAt?: OpenMoment;
  opensAt?: OpenMoment;
  // a holiday / special-hours day today
  exceptionToday?: boolean;
};

const momentOf = (m: number, today: number, endOfRange = false): OpenMoment => {
  // a closing time at midnight reads "24:00" of the day before
  const dayOffset = endOfRange ? Math.ceil(m / DAY_MINUTES) - 1 : Math.floor(m / DAY_MINUTES);
  return { dayOffset, minutes: m - dayOffset * DAY_MINUTES, day: (today + dayOffset) % 7 };
};

// "open now / closes at 22:00 / opens tomorrow 08:00" as data: the pages
// and cards word it in the visitor's language. null = no hours given.
export const openStatusAt = (hours: unknown, at: DateLike = new Date()): OpenStatus | null => {
  if (!hasAnyHours(hours)) return null;
  const { merged, now, today } = intervalsAround(hours, at, -1, LOOKAHEAD_DAYS);
  const ymd = tehranParts(at).ymd;
  const exceptionToday = Array.isArray(hours.exceptions) && hours.exceptions.some((e) => e?.date === ymd);
  const current = merged.find((i) => i.s <= now && now < i.e);
  if (current) {
    if (current.e >= LOOKAHEAD_DAYS * DAY_MINUTES) return { open: true, allDay: true, ...(exceptionToday && { exceptionToday }) };
    return { open: true, closesAt: momentOf(current.e, today, true), ...(exceptionToday && { exceptionToday }) };
  }
  const next = merged.find((i) => i.s > now);
  return {
    open: false,
    ...(next && { opensAt: momentOf(next.s, today) }),
    ...(exceptionToday && { exceptionToday }),
  };
};

// ------------------------------------------------------------ lists

// what a list response shows: the status at `now` on every row, the
// derived intervals left out
export const withOpenStatus = (rows: readonly unknown[], now: Date = new Date()): Record<string, any>[] =>
  (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== "object") return row as Record<string, any>;
    const plain =
      typeof (row as { toJSON?: unknown }).toJSON === "function"
        ? ((row as unknown as { toJSON: () => Record<string, unknown> }).toJSON() as Record<string, unknown>)
        : ({ ...(row as Record<string, unknown>) } as Record<string, unknown>);
    const hours = plain.openingHours as OpeningHours | undefined;
    if (hours && typeof hours === "object") {
      const { weekIntervals: _w, ...rest } = hours;
      plain.openingHours = rest;
    }
    plain.openStatus = openStatusAt(hours, now);
    return plain;
  });

export const withOpenStatusOne = (row: unknown, now: Date = new Date()) => withOpenStatus([row], now)[0];

// The ids of the centres among `match` that are open at `now` (Tehran):
// Mongo narrows to the ones whose week has `now` inside, round-the-clock
// ones, or ones with an exception today / yesterday; the exact rule
// (exceptions, overnight from yesterday) is isOpenAt.
export const openNowIds = async (
  model: mongoose.Model<any>,
  match: Record<string, unknown>,
  now: Date = new Date(),
): Promise<mongoose.Types.ObjectId[]> => {
  const minute = tehranWeekMinute(now);
  const ymd = tehranParts(now).ymd;
  const candidates = await model
    .find({
      $and: [
        match,
        {
          $or: [
            { "openingHours.weekIntervals": { $elemMatch: { s: { $lte: minute }, e: { $gt: minute } } } },
            { "openingHours.exceptions.date": { $in: [ymd, addDaysYmd(ymd, -1)] } },
          ],
        },
      ],
    })
    .select("_id openingHours")
    .lean<{ _id: mongoose.Types.ObjectId; openingHours?: OpeningHours }[]>();
  return candidates.filter((c) => isOpenAt(c.openingHours, now)).map((c) => c._id);
};

// ------------------------------------------------------------ plugin

type PluginOptions = { roundTheClockField?: string };

// Keeps the round-the-clock flag and the structured hours one fact:
// - hours sent: they are normalized, weekIntervals derived and the flag
//   set from them (every day 00:00-24:00);
// - only the flag sent: true fills every day with 00:00-24:00 (exceptions
//   kept), false clears hours that were round the clock.
export const openingHoursPlugin = (schema: mongoose.Schema, opts: PluginOptions = {}) => {
  const flag = opts.roundTheClockField || "isRoundTheClock";
  schema.add({ openingHours: { type: openingHoursSchema, default: undefined } });
  schema.index({ "openingHours.weekIntervals.s": 1, "openingHours.weekIntervals.e": 1 });

  schema.pre("save", function () {
    const doc = this as mongoose.Document & Record<string, any>;
    const hoursChanged = doc.isModified("openingHours");
    if (!hoursChanged && !doc.isModified(flag) && !doc.isNew) return;
    const current = doc.get("openingHours");
    const plain = current && typeof current.toObject === "function" ? current.toObject() : current;
    if (hoursChanged && plain) {
      const h = normalizeOpeningHours(plain);
      doc.set("openingHours", h ?? undefined);
      doc.set(flag, isRoundTheClockHours(h));
      return;
    }
    const exceptions = Array.isArray(plain?.exceptions) ? plain.exceptions : [];
    if (doc.get(flag)) doc.set("openingHours", normalizeOpeningHours({ days: roundTheClockDays(), exceptions }));
    else if (isRoundTheClockHours(plain))
      doc.set("openingHours", normalizeOpeningHours({ days: [], exceptions }) ?? undefined);
  });

  const onUpdate = async function (this: mongoose.Query<unknown, unknown>) {
    const update = (this.getUpdate() || {}) as Record<string, any>;
    const set: Record<string, any> = update.$set || update;
    const hoursGiven = "openingHours" in set;
    const flagGiven = flag in set;
    if (!hoursGiven && !flagGiven) return;
    if (hoursGiven) {
      const h = normalizeOpeningHours(set.openingHours);
      if (h) set.openingHours = h;
      else {
        delete set.openingHours;
        update.$unset = { ...(update.$unset || {}), openingHours: 1 };
      }
      set[flag] = isRoundTheClockHours(h);
      if (update.$set) update.$set = set;
      this.setUpdate(update);
      return;
    }
    const on = set[flag] === true || set[flag] === "true" || set[flag] === 1 || set[flag] === "1";
    const current = (await this.model
      .findOne(this.getQuery())
      .select("openingHours")
      .lean()) as { openingHours?: OpeningHours } | null;
    const exceptions = current?.openingHours?.exceptions || [];
    if (on) {
      set.openingHours = normalizeOpeningHours({ days: roundTheClockDays(), exceptions });
    } else if (isRoundTheClockHours(current?.openingHours)) {
      const rest = normalizeOpeningHours({ days: [], exceptions });
      if (rest) set.openingHours = rest;
      else update.$unset = { ...(update.$unset || {}), openingHours: 1 };
    }
    if (update.$set) update.$set = set;
    this.setUpdate(update);
  };
  schema.pre("findOneAndUpdate", onUpdate);
  schema.pre("updateOne", onUpdate);
};

// ------------------------------------------------------------ schema.org

const SCHEMA_DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// openingHoursSpecification of a LocalBusiness: one entry per range (a
// range past midnight closes at its end time, as Google reads it), and the
// upcoming exceptions with their dates (closed = 00:00-00:00)
export const openingHoursSpecification = (hours: unknown, now: Date = new Date()) => {
  if (!hasAnyHours(hours)) return undefined;
  const out: Record<string, unknown>[] = [];
  if (hasWeeklyHours(hours)) {
    hours.days.forEach((d, i) => {
      for (const r of Array.isArray(d?.ranges) ? d.ranges : [])
        out.push({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: `https://schema.org/${SCHEMA_DAYS[i]}`,
          opens: hhmm(r.start),
          closes: r.end === DAY_MINUTES ? "23:59" : hhmm(r.end),
        });
    });
  }
  const today = tehranParts(now).ymd;
  for (const e of Array.isArray(hours.exceptions) ? hours.exceptions : []) {
    if (!e?.date || e.date < today) continue;
    const ranges = Array.isArray(e.ranges) && e.ranges.length ? e.ranges : [{ start: 0, end: 0 }];
    for (const r of ranges)
      out.push({
        "@type": "OpeningHoursSpecification",
        validFrom: e.date,
        validThrough: e.date,
        opens: hhmm(r.start),
        closes: r.end === DAY_MINUTES ? "23:59" : hhmm(r.end),
      });
  }
  return out.length ? out : undefined;
};

// ------------------------------------------------------------ legacy text

const toLatinDigits = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const ROUND_THE_CLOCK_TEXT = /^(شبانه[\s‌-]*روزی|۲۴|24)?\s*(شبانه[\s‌-]*روزی|24\s*ساعته|24\s*\/\s*7|24\s*h(ours)?|24\s*ساعت(ه)?|round\s*the\s*clock)$/i;

// An hour like "8", "8:30", "8 صبح", "10 شب" in minutes (null = not one)
const hourOf = (text: string): number | null => {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(صبح|ظهر|بعدازظهر|بعد از ظهر|عصر|شب)?$/.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 24 || min > 59) return null;
  const part = m[3];
  if (part && part !== "صبح" && h < 12) h += 12;
  if (part === "شب" && h === 24) h = 24;
  return h * 60 + min;
};

// Simple free-text hours read as structure: "شبانه روزی", "8-22",
// "۸ تا ۲۲", "از ساعت ۸ صبح تا ۱۰ شب", "8-13 و 16-21" (every day). Anything
// else (days named, several sentences) is null: left for the centre to set.
export const parseLegacyHours = (text: unknown): { roundTheClock: boolean; days: HoursDay[] } | null => {
  if (typeof text !== "string") return null;
  let s = toLatinDigits(text).replace(/‌/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (ROUND_THE_CLOCK_TEXT.test(s)) return { roundTheClock: true, days: roundTheClockDays() };
  s = s
    .replace(/^(همه ?روزه|هر ?روز|روزانه|همه روزهای هفته)\s*/u, "")
    .replace(/(همه ?روزه|هر ?روز|روزانه)$/u, "")
    .replace(/ساعت\s*/g, "")
    .trim();
  const parts = s.split(/\s*(?:،|,|\sو\s|;)\s*/u).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const ranges: HoursRange[] = [];
  for (const part of parts) {
    const m = /^(?:از\s*)?(.+?)\s*(?:-|–|—|تا|الی|to)\s*(.+)$/u.exec(part.trim());
    if (!m) return null;
    const start = hourOf(m[1]);
    const end = hourOf(m[2]);
    if (start === null || end === null || start >= DAY_MINUTES) return null;
    const r = rangeOf({ start, end: end === 0 ? DAY_MINUTES : end });
    if (!r) return null;
    ranges.push(r);
  }
  const cleaned = cleanRanges(ranges);
  if (!cleaned || !cleaned.length) return null;
  const days = Array.from({ length: 7 }, () => ({ ranges: cleaned.map((r) => ({ ...r })) }));
  return { roundTheClock: days.every(fullDay), days };
};

// A short week in a language without a dictionary (2026-10, the SEO
// resolver's {hours}): weekday names from Intl, days with the same ranges
// grouped ("Sat–Thu 08:00–22:00, Fri 20:00–02:00"); closed days left out.
export const hoursSummary = (hours: unknown, locale: string) => {
  if (!hasWeeklyHours(hours)) return "";
  let dayName: Intl.DateTimeFormat;
  let digits: Intl.NumberFormat;
  try {
    dayName = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    digits = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  } catch {
    dayName = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
    digits = new Intl.NumberFormat("en", { minimumIntegerDigits: 2, useGrouping: false });
  }
  // 2026-10-10 (UTC) was a Saturday
  const nameOf = (i: number) => dayName.format(new Date(Date.UTC(2026, 9, 10 + i, 12)));
  const t = (m: number) => `${digits.format(Math.floor(m / 60))}:${digits.format(m % 60)}`;
  const key = (d: HoursDay) => (Array.isArray(d?.ranges) ? d.ranges : []).map((r) => `${t(r.start)}–${t(r.end)}`).join(" ");
  const groups: { from: number; to: number; text: string }[] = [];
  hours.days.forEach((d, i) => {
    const text = key(d);
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  const parts = groups
    .filter((g) => g.text)
    .map((g) => `${g.from === g.to ? nameOf(g.from) : `${nameOf(g.from)}–${nameOf(g.to)}`} ${g.text}`);
  try {
    return new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(parts);
  } catch {
    return parts.join(", ");
  }
};
