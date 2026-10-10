import { addDaysYmd } from "./tehranTime";

// Iran's lunar official holidays, worked out for the years the official
// calendar has not been entered for (2026-10, the owner's rule: "the super
// admin must not type them by hand"). Iran's Hijri months start by sighting
// (University of Tehran Geophysics Institute); the astronomical Islamic
// calendar one day later matches the official 1405 calendar on 15 of its 18
// lunar days and is one day off on the rest, so these days are marked
// `estimated` (the panels say «تاریخ تقریبی») until an admin sets the
// official day - an edited day is no longer estimated and is never
// regenerated (Lib/publicHolidaySeed.ts).

type Occasion = { key: string; month: number; day: number | "last"; title: string };

// Hijri month / day of each official lunar holiday
export const LUNAR_OCCASIONS: Occasion[] = [
  { key: "tasua", month: 1, day: 9, title: "تاسوعای حسینی" },
  { key: "ashura", month: 1, day: 10, title: "عاشورای حسینی" },
  { key: "arbaeen", month: 2, day: 20, title: "اربعین حسینی" },
  { key: "rasul-hasan", month: 2, day: 28, title: "رحلت رسول اکرم (ص) و شهادت امام حسن مجتبی (ع)" },
  // the last day of Safar (29th or 30th)
  { key: "reza", month: 2, day: "last", title: "شهادت امام رضا (ع)" },
  { key: "askari", month: 3, day: 8, title: "شهادت امام حسن عسکری (ع)" },
  { key: "mawlid", month: 3, day: 17, title: "میلاد رسول اکرم (ص) و امام جعفر صادق (ع)" },
  { key: "fatima", month: 6, day: 3, title: "شهادت حضرت فاطمه زهرا (س)" },
  { key: "ali-birth", month: 7, day: 13, title: "ولادت امام علی (ع) و روز پدر" },
  { key: "mabath", month: 7, day: 27, title: "مبعث رسول اکرم (ص)" },
  { key: "shaban", month: 8, day: 15, title: "ولادت حضرت قائم (عج) و جشن نیمه شعبان" },
  { key: "ali-martyr", month: 9, day: 21, title: "شهادت امام علی (ع)" },
  { key: "fitr-1", month: 10, day: 1, title: "عید سعید فطر" },
  { key: "fitr-2", month: 10, day: 2, title: "تعطیل به مناسبت عید سعید فطر" },
  { key: "sadegh", month: 10, day: 25, title: "شهادت امام جعفر صادق (ع)" },
  { key: "adha", month: 12, day: 10, title: "عید سعید قربان" },
  { key: "ghadir", month: 12, day: 18, title: "عید سعید غدیر خم" },
];

const hijriFmt = new Intl.DateTimeFormat("en-u-ca-islamic-nu-latn", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

// the Iranian Hijri date of a Tehran day: the astronomical one of the day before
export const iranHijri = (ymd: string) => {
  const parts = hijriFmt.formatToParts(new Date(`${addDaysYmd(ymd, -1)}T12:00:00Z`));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: n("year"), month: n("month"), day: n("day") };
};

export type EstimatedHoliday = { ymd: string; title: string; key: string; hijriYear: number };

// every estimated lunar holiday from one Tehran day to another
export const estimatedLunarHolidays = (fromYmd: string, toYmd: string): EstimatedHoliday[] => {
  const out: EstimatedHoliday[] = [];
  for (let ymd = fromYmd; ymd <= toYmd; ymd = addDaysYmd(ymd, 1)) {
    const h = iranHijri(ymd);
    if (!Number.isFinite(h.month) || !Number.isFinite(h.day)) continue;
    const next = iranHijri(addDaysYmd(ymd, 1));
    for (const o of LUNAR_OCCASIONS) {
      const hit = o.day === "last" ? h.month === o.month && next.month !== o.month : h.month === o.month && h.day === o.day;
      if (hit) out.push({ ymd, title: o.title, key: o.key, hijriYear: h.year });
    }
  }
  return out;
};
