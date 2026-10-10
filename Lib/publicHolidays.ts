import PublicHoliday from "../Models/PublicHoliday";
import DoctorHolidayPolicy from "../Models/DoctorHolidayPolicy";
import { currentLocale } from "./i18n/requestContext";
import { SOURCE_LOCALE } from "./locales";
import { fromTehranWallClock } from "./tehranTime";

// Iran's official holidays and each doctor's choice for them (2026-10,
// Doctolib Pro's public-holiday closures, Paziresh24 / Nobat offices shut on
// «تعطیل رسمی»). The one rule: a doctor is closed on an active holiday
// unless they work on holidays (their switch) or opened that day; a day they
// closed against the switch stays closed. A closed holiday blocks the whole
// day like a whole-day time off: `holidayClosures` gives it in the time-off
// shape and Lib/timeOff.ts `loadTimeOff` adds it to the real time off, so
// every place that reads free slots (the slot picker, the cards' first
// slot, the availability cache, booking, moves, the desk, the waitlist)
// applies it the same way.

export type HolidayRow = {
  ymd: string;
  title: string;
  // worked out, not yet the official day (Lib/lunarHolidays.ts)
  estimated?: boolean;
  translations?: Record<string, { title?: unknown } | undefined>;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// the active holidays, cached briefly (they change a few times a year;
// an admin edit clears it, Routers/autoRouter.ts)
const TTL_MS = 60_000;
let cache: { at: number; rows: HolidayRow[] } | null = null;

export const clearHolidayCache = () => {
  cache = null;
};

export const activeHolidays = async (): Promise<HolidayRow[]> => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await PublicHoliday.find({ active: true })
    .select("ymd title estimated translations")
    .sort({ ymd: 1 })
    .lean<HolidayRow[]>();
  const clean = (Array.isArray(rows) ? rows : []).filter(
    (r) => !!r && typeof r.ymd === "string" && YMD.test(r.ymd) && typeof r.title === "string",
  );
  cache = { at: Date.now(), rows: clean };
  return clean;
};

// the active holidays from one Tehran day to another, both included
export const holidaysBetween = async (fromYmd: string, toYmd: string) =>
  (await activeHolidays()).filter((h) => h.ymd >= fromYmd && h.ymd <= toYmd);

// the holiday's title in the request's language (Persian when missing)
export const holidayTitle = (h: HolidayRow) => {
  const locale = currentLocale();
  const own = locale !== SOURCE_LOCALE ? h.translations?.[locale]?.title : undefined;
  return typeof own === "string" && own.trim() ? own : h.title;
};

// ------------------------------------------------------------- policy

export type HolidayPolicy = { works: boolean; open: string[]; closed: string[] };

export const defaultPolicy = (): HolidayPolicy => ({ works: false, open: [], closed: [] });

const cleanList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && YMD.test(x)) : []);

const toPolicy = (row: unknown): HolidayPolicy => {
  const r = (row || {}) as Partial<HolidayPolicy>;
  return { works: r.works === true, open: cleanList(r.open), closed: cleanList(r.closed) };
};

// is the doctor closed on this holiday
export const isClosedOn = (policy: HolidayPolicy | null | undefined, ymd: string) => {
  const p = policy || defaultPolicy();
  if (p.open.includes(ymd)) return false;
  if (p.closed.includes(ymd)) return true;
  return !p.works;
};

export const policyOf = async (doctor: unknown): Promise<HolidayPolicy> =>
  toPolicy(await DoctorHolidayPolicy.findOne({ doctor }).select("works open closed").lean());

const policiesOf = async (ids: unknown[]) => {
  const rows = await DoctorHolidayPolicy.find({ doctor: { $in: ids } })
    .select("doctor works open closed")
    .lean();
  return new Map(rows.map((r) => [String(r.doctor), toPolicy(r)]));
};

export type HolidayClosure = { doctor: unknown; from: Date; to: Date; holiday: string };

// The holidays each doctor is closed on between two Tehran days, as
// whole-day time off records (Lib/timeOff.ts).
export const holidayClosures = async (
  doctors: unknown[],
  fromYmd: string,
  toYmd: string,
): Promise<HolidayClosure[]> => {
  const days = await holidaysBetween(fromYmd, toYmd);
  if (!days.length || !doctors.length) return [];
  const policies = await policiesOf(doctors);
  const out: HolidayClosure[] = [];
  for (const doctor of doctors) {
    const policy = policies.get(String(doctor));
    for (const day of days) {
      if (!isClosedOn(policy, day.ymd)) continue;
      const at = fromTehranWallClock(day.ymd, 0);
      out.push({ doctor, from: at, to: at, holiday: day.title });
    }
  }
  return out;
};

// The holidays of a doctor between two Tehran days with their choice, for
// the slot picker and the doctor's own list (title in the request's
// language).
export const doctorHolidays = async (doctor: unknown, fromYmd: string, toYmd: string) => {
  const [days, policy] = await Promise.all([holidaysBetween(fromYmd, toYmd), policyOf(doctor)]);
  return days.map((d) => ({ ymd: d.ymd, title: holidayTitle(d), closed: isClosedOn(policy, d.ymd), estimated: !!d.estimated }));
};
