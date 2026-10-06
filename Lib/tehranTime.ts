import moment from "moment-jalaali";

// Tehran time (2026-10, owner's decision: the site runs on Tehran time).
//
// Visit minutes (shift / reservation start, end), time off hours, campaign
// windows, "today", Jalali months: all of them are Tehran wall-clock. The
// server's own zone (UTC on ArvanCloud unless TZ is set) must never decide
// any of them, so every calendar computation goes through this module, which
// reads Tehran through Intl (the ICU zone database: +03:30 now, and the
// +04:30 summers before 1402 for old records).
//
// A reservation / availability `date` is a day key: the midnight of the
// visit's day. New records store Tehran's midnight (20:30 UTC the day before).
// Records written on a server running in UTC hold UTC midnight of the same
// calendar day (03:30 Tehran); both instants fall inside the same Tehran day,
// so readers take the day with tehranYmd(date) or query whole Tehran days
// (tehranDayRange), never compare a day key for equality.

export const TEHRAN_TZ = "Asia/Tehran";

export type DateLike = Date | number | string;

export type TehranParts = {
  year: number;
  // 1-12
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  // 0 = Sunday ... 6 = Saturday, as Date#getDay
  weekday: number;
  // "YYYY-MM-DD" of the Tehran calendar day
  ymd: string;
  // minutes since Tehran midnight
  minutes: number;
};

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TEHRAN_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const toDate = (d: DateLike) => (d instanceof Date ? d : new Date(d));

const ymdOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

// the wall clock in Tehran at an instant
export const tehranParts = (at: DateLike = new Date()): TehranParts => {
  const date = toDate(at);
  if (isNaN(date.getTime())) throw new RangeError("Invalid date");
  const p: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(date)) p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  // some ICU builds still print 24 for midnight
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const second = Number(p.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAYS[p.weekday] ?? 0,
    ymd: ymdOf(year, month, day),
    minutes: hour * 60 + minute,
  };
};

// alias of tehranParts: the Tehran wall clock of an instant
export const toTehranWallClock = tehranParts;

// "YYYY-MM-DD" of the Tehran day an instant falls in
export const tehranYmd = (at: DateLike = new Date()) => tehranParts(at).ymd;

// minutes since Tehran midnight (0-1439)
export const tehranMinutesOfDay = (at: DateLike = new Date()) => tehranParts(at).minutes;

// 0 = Sunday ... 6 = Saturday, in Tehran
export const tehranWeekday = (at: DateLike = new Date()) => tehranParts(at).weekday;

// the shift's day index (0 = Saturday ... 6 = Friday) of the Tehran day
export const tehranSaturdayDay = (at: DateLike = new Date()) => (tehranWeekday(at) + 1) % 7;

// minutes Tehran is ahead of UTC at an instant (210 now, 270 in old summers)
export const tehranOffsetMinutes = (at: DateLike = new Date()) => {
  const date = toDate(at);
  const p = tehranParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

const YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const splitYmd = (ymd: string) => {
  const m = YMD.exec(ymd.trim());
  if (!m) throw new RangeError(`Invalid day: ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};

// The instant of a Tehran wall-clock time: a "YYYY-MM-DD" day (or y/m/d)
// plus minutes since its midnight. Minutes past 1440 roll into the next
// days, as a visit ending at 24:00 does.
export function fromTehranWallClock(ymd: string, minutes?: number): Date;
export function fromTehranWallClock(year: number, month: number, day: number, minutes?: number): Date;
export function fromTehranWallClock(a: string | number, b?: number, c?: number, d?: number): Date {
  let y: number, m: number, day: number, minutes: number;
  if (typeof a === "string") {
    [y, m, day] = splitYmd(a);
    minutes = Number(b) || 0;
  } else {
    y = a;
    m = Number(b);
    day = Number(c);
    minutes = Number(d) || 0;
  }
  const wall = Date.UTC(y, m - 1, day, 0, 0, 0) + Math.round(minutes * 60000);
  // the offset at the wall time itself; a second pass settles the instants
  // next to an old daylight-saving switch
  let guess = wall - tehranOffsetMinutes(wall) * 60000;
  guess = wall - tehranOffsetMinutes(guess) * 60000;
  return new Date(guess);
}

// Tehran's midnight of the day an instant falls in
export const startOfTehranDay = (at: DateLike = new Date()) => fromTehranWallClock(tehranYmd(at), 0);

// "YYYY-MM-DD" n calendar days after a "YYYY-MM-DD" day
export const addDaysYmd = (ymd: string, n: number) => {
  const [y, m, d] = splitYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymdOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

// whole calendar days from one "YYYY-MM-DD" day to another
export const diffDaysYmd = (from: string, to: string) => {
  const [y1, m1, d1] = splitYmd(from);
  const [y2, m2, d2] = splitYmd(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
};

// Tehran's midnight n calendar days after the day of `at`
export const addTehranDays = (at: DateLike, n: number) => fromTehranWallClock(addDaysYmd(tehranYmd(at), n), 0);

// the last millisecond of a Tehran "YYYY-MM-DD" day (for $lte ranges)
export const endOfTehranDayYmd = (ymd: string) => new Date(fromTehranWallClock(addDaysYmd(ymd, 1), 0).getTime() - 1);

// noon of a Tehran "YYYY-MM-DD" day (a date that must never slip a day);
// anything else Date can parse is taken as is
export const tehranNoonOf = (s: string) => (YMD.test(s.trim()) ? fromTehranWallClock(s.trim(), 12 * 60) : new Date(s));

// a business document's own date from a "YYYY-MM-DD" day: noon of that
// Tehran day, or now when it is today (it keeps the time it was written)
export const tehranDocDate = (ymd?: string | null, now = new Date()) => {
  if (!ymd || !YMD.test(ymd)) return now;
  return ymd === tehranYmd(now) ? now : fromTehranWallClock(ymd, 12 * 60);
};

// the Tehran day of `at` as [start, end): end is the next day's midnight
export const tehranDayRange = (at: DateLike = new Date()) => {
  const start = startOfTehranDay(at);
  return { start, end: addTehranDays(start, 1) };
};

// The Tehran day a client meant: "YYYY-MM-DD" is that calendar day; a full
// timestamp (an older client sent its device's midnight) is the Tehran day
// of that instant. Returns Tehran's midnight; null when it is no date.
export const parseTehranDay = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && YMD.test(value.trim())) return fromTehranWallClock(value.trim(), 0);
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (isNaN(d.getTime())) return null;
  return startOfTehranDay(d);
};

// The instant of a visit: its stored day key plus minutes (start / end) of
// Tehran wall-clock. Reads both day-key conventions (see the top).
export const tehranInstantOf = (dayKey: DateLike, minutes: number) => fromTehranWallClock(tehranYmd(dayKey), minutes);

// the Tehran calendar days of [start, end] as "YYYY-MM-DD", oldest first
export const tehranDaysBetween = (start: DateLike, end: DateLike, max = 400) => {
  const out: string[] = [];
  const last = tehranYmd(end);
  for (let ymd = tehranYmd(start); ymd <= last && out.length < max; ymd = addDaysYmd(ymd, 1)) out.push(ymd);
  return out;
};

// A calendar date saved without a time (a birth date): older records hold
// UTC midnight, newer ones Tehran midnight. True when `given` (any instant
// or "YYYY-MM-DD") is the same calendar day as `stored` read either way.
export const sameCalendarDay = (stored: DateLike, given: DateLike) => {
  const s = toDate(stored);
  const g = typeof given === "string" && YMD.test(given.trim()) ? given.trim() : tehranYmd(given);
  if (isNaN(s.getTime())) return false;
  const utc = ymdOf(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
  return g === utc || g === tehranYmd(s);
};

// ------------------------------------------------------------- Jalali

export type JalaliParts = { jy: number; jm: number; jd: number };

// moment-jalaali's calendar converter (pure calendar math, no zone; months
// 0-based both ways); its typings leave it out
const jConvert = (
  moment as unknown as {
    jConvert: {
      toJalaali: (gy: number, gm: number, gd: number) => JalaliParts;
      toGregorian: (jy: number, jm: number, jd: number) => { gy: number; gm: number; gd: number };
    };
  }
).jConvert;

// the Jalali date of the Tehran day an instant falls in (jm 1-12)
export const tehranJalali = (at: DateLike = new Date()): JalaliParts => {
  const p = tehranParts(at);
  const j = jConvert.toJalaali(p.year, p.month - 1, p.day);
  return { jy: j.jy, jm: j.jm + 1, jd: j.jd };
};

// "YYYY-MM-DD" (Gregorian) of a Jalali date
export const jalaliToYmd = (jy: number, jm: number, jd: number) => {
  const g = jConvert.toGregorian(jy, jm - 1, jd);
  return ymdOf(g.gy, g.gm + 1, g.gd);
};

export const jalaliMonthLength = (jy: number, jm: number) => moment.jDaysInMonth(jy, jm - 1);

// a Jalali month [start, end) at Tehran midnights; jm may run past 12 or
// below 1 (it rolls the year)
export const jalaliMonthRange = (jy: number, jm: number) => {
  const idx = jy * 12 + (jm - 1);
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const ny = Math.floor((idx + 1) / 12);
  const nm = ((idx + 1) % 12) + 1;
  return {
    start: fromTehranWallClock(jalaliToYmd(y, m, 1), 0),
    end: fromTehranWallClock(jalaliToYmd(ny, nm, 1), 0),
    jy: y,
    jm: m,
    days: jalaliMonthLength(y, m),
  };
};

// Tehran's midnight of the first of the Jalali month an instant falls in;
// `add` months later (negative: earlier)
export const startOfTehranJalaliMonth = (at: DateLike = new Date(), add = 0) => {
  const j = tehranJalali(at);
  return jalaliMonthRange(j.jy, j.jm + add).start;
};

// the Jalali year [start, end) at Tehran midnights (1 Farvardin)
export const jalaliYearRange = (jy: number) => ({
  start: fromTehranWallClock(jalaliToYmd(jy, 1, 1), 0),
  end: fromTehranWallClock(jalaliToYmd(jy + 1, 1, 1), 0),
});

// a moment in Tehran's offset at that instant, for the Jalali formats
// (jYYYY/jMM/jDD) of code that already uses moment-jalaali
export const tehranMoment = (at?: DateLike) => {
  const d = at === undefined ? new Date() : toDate(at);
  return moment(d).utcOffset(tehranOffsetMinutes(d));
};

// "jYYYY/jMM/jDD" (or another moment-jalaali format) in Tehran
export const tehranJalaliFormat = (at: DateLike = new Date(), format = "jYYYY/jMM/jDD") => tehranMoment(at).format(format);
