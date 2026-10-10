import PublicHoliday, { PublicHolidayKind } from "../Models/PublicHoliday";
import { jalaliToYmd } from "./tehranTime";
import { clearHolidayCache } from "./publicHolidays";

// The official holidays of the Iranian years 1405 and 1406 (2026-10), seeded
// once each at boot (idempotent: a row is added only when neither its seed
// key nor its day exists, so an admin's edit or switch-off stays, and a day
// the admin already entered is not doubled). Sources: the official 1405
// calendar of the University of Tehran Geophysics Institute (as published
// by time.ir, bahesab.ir and the press when the Council of Public Culture
// approved it), cross-checked against at least two of them and against the
// lunar arithmetic (each month 29 or 30 days).
//
// 1406: only the fixed solar days. Its lunar days come from the official
// 1406 calendar, not published yet when this was written - the super admin
// adds them (booking settings -> «تعطیلات رسمی») once it is. Never guessed.
//
// A day with two occasions (Nowruz and Eid al-Fitr in 1405, Imam
// Khomeini's death and Eid al-Ghadir) is one row with both titles.

type Seed = { key: string; jy: number; jm: number; jd: number; title: string; kind: PublicHolidayKind };

const solar = (jy: number): Seed[] => [
  { key: `${jy}-nowruz-1`, jy, jm: 1, jd: 1, title: "عید نوروز", kind: "solar" },
  { key: `${jy}-nowruz-2`, jy, jm: 1, jd: 2, title: "عید نوروز", kind: "solar" },
  { key: `${jy}-nowruz-3`, jy, jm: 1, jd: 3, title: "عید نوروز", kind: "solar" },
  { key: `${jy}-nowruz-4`, jy, jm: 1, jd: 4, title: "عید نوروز", kind: "solar" },
  { key: `${jy}-republic`, jy, jm: 1, jd: 12, title: "روز جمهوری اسلامی", kind: "solar" },
  { key: `${jy}-nature`, jy, jm: 1, jd: 13, title: "روز طبیعت", kind: "solar" },
  { key: `${jy}-khomeini`, jy, jm: 3, jd: 14, title: "رحلت امام خمینی", kind: "solar" },
  { key: `${jy}-15khordad`, jy, jm: 3, jd: 15, title: "قیام ۱۵ خرداد", kind: "solar" },
  { key: `${jy}-revolution`, jy, jm: 11, jd: 22, title: "پیروزی انقلاب اسلامی", kind: "solar" },
  { key: `${jy}-oil`, jy, jm: 12, jd: 29, title: "ملی شدن صنعت نفت", kind: "solar" },
];

// 1405 lunar days (Hijri 1447-1448), official calendar
const lunar1405: Seed[] = [
  { key: "1405-fitr-1447-1", jy: 1405, jm: 1, jd: 1, title: "عید سعید فطر", kind: "lunar" },
  { key: "1405-fitr-1447-2", jy: 1405, jm: 1, jd: 2, title: "تعطیل به مناسبت عید سعید فطر", kind: "lunar" },
  { key: "1405-sadegh", jy: 1405, jm: 1, jd: 25, title: "شهادت امام جعفر صادق (ع)", kind: "lunar" },
  { key: "1405-adha", jy: 1405, jm: 3, jd: 6, title: "عید سعید قربان", kind: "lunar" },
  { key: "1405-ghadir", jy: 1405, jm: 3, jd: 14, title: "عید سعید غدیر خم", kind: "lunar" },
  { key: "1405-tasua", jy: 1405, jm: 4, jd: 3, title: "تاسوعای حسینی", kind: "lunar" },
  { key: "1405-ashura", jy: 1405, jm: 4, jd: 4, title: "عاشورای حسینی", kind: "lunar" },
  { key: "1405-arbaeen", jy: 1405, jm: 5, jd: 13, title: "اربعین حسینی", kind: "lunar" },
  { key: "1405-rasul-hasan", jy: 1405, jm: 5, jd: 21, title: "رحلت رسول اکرم (ص) و شهادت امام حسن مجتبی (ع)", kind: "lunar" },
  { key: "1405-reza", jy: 1405, jm: 5, jd: 22, title: "شهادت امام رضا (ع)", kind: "lunar" },
  { key: "1405-askari", jy: 1405, jm: 5, jd: 30, title: "شهادت امام حسن عسکری (ع)", kind: "lunar" },
  { key: "1405-mawlid", jy: 1405, jm: 6, jd: 8, title: "میلاد رسول اکرم (ص) و امام جعفر صادق (ع)", kind: "lunar" },
  { key: "1405-fatima", jy: 1405, jm: 8, jd: 22, title: "شهادت حضرت فاطمه زهرا (س)", kind: "lunar" },
  { key: "1405-ali-birth", jy: 1405, jm: 10, jd: 2, title: "ولادت امام علی (ع) و روز پدر", kind: "lunar" },
  { key: "1405-mabath", jy: 1405, jm: 10, jd: 16, title: "مبعث رسول اکرم (ص)", kind: "lunar" },
  { key: "1405-shaban", jy: 1405, jm: 11, jd: 4, title: "ولادت حضرت قائم (عج) و جشن نیمه شعبان", kind: "lunar" },
  { key: "1405-ali-martyr", jy: 1405, jm: 12, jd: 9, title: "شهادت امام علی (ع)", kind: "lunar" },
  { key: "1405-fitr-1448-1", jy: 1405, jm: 12, jd: 19, title: "عید سعید فطر", kind: "lunar" },
  { key: "1405-fitr-1448-2", jy: 1405, jm: 12, jd: 20, title: "تعطیل به مناسبت عید سعید فطر", kind: "lunar" },
];

export const holidaySeeds: Seed[] = [...solar(1405), ...lunar1405, ...solar(1406)];

// one row per day: the titles of a day with two occasions joined
export const seedRows = () => {
  const byDay = new Map<string, { ymd: string; title: string; kind: PublicHolidayKind; seedKey: string }>();
  for (const s of holidaySeeds) {
    const ymd = jalaliToYmd(s.jy, s.jm, s.jd);
    const row = byDay.get(ymd);
    if (!row) byDay.set(ymd, { ymd, title: s.title, kind: s.kind, seedKey: s.key });
    else if (!row.title.includes(s.title)) row.title = `${row.title} · ${s.title}`;
  }
  return [...byDay.values()].sort((a, b) => a.ymd.localeCompare(b.ymd));
};

export const seedPublicHolidays = async () => {
  let added = 0;
  for (const row of seedRows()) {
    const exists = await PublicHoliday.exists({ $or: [{ seedKey: row.seedKey }, { ymd: row.ymd }] });
    if (exists) continue;
    await PublicHoliday.create({ ...row, active: true })
      .then(() => added++)
      .catch(() => undefined);
  }
  if (added) {
    clearHolidayCache();
    console.log(`[holidays] ${added} official holidays seeded`);
  }
  return added;
};
