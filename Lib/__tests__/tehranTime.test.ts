// Lib/tehranTime.ts: Tehran wall-clock whatever the process zone.
//   npx tsx --test Lib/__tests__/tehranTime.test.ts
//   TZ=UTC npx tsx --test ...   /   TZ=America/New_York npx tsx --test ...
// must all pass: nothing here may depend on the server's zone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysYmd,
  addTehranDays,
  diffDaysYmd,
  endOfTehranDayYmd,
  fromTehranWallClock,
  jalaliMonthRange,
  jalaliToYmd,
  jalaliYearRange,
  parseTehranDay,
  sameCalendarDay,
  startOfTehranDay,
  startOfTehranJalaliMonth,
  tehranDayRange,
  tehranDaysBetween,
  tehranDocDate,
  tehranInstantOf,
  tehranJalali,
  tehranJalaliFormat,
  tehranMinutesOfDay,
  tehranOffsetMinutes,
  tehranParts,
  tehranSaturdayDay,
  tehranWeekday,
  tehranYmd,
} from "../tehranTime";
import { dateStartOfDay, getDaysInRange, todayStart, tomorrowStart } from "../dateUtils";
import { getSessionDateKey } from "../helpers";
import { blockedFrom } from "../timeOff";

const iso = (d: Date) => d.toISOString();

describe("tehranParts", () => {
  it("23:45 Tehran is still the previous day in UTC", () => {
    // 2026-10-06 23:45 Tehran = 2026-10-06 20:15 UTC: same Tehran day
    const at = new Date("2026-10-06T20:15:00Z");
    const p = tehranParts(at);
    assert.equal(p.ymd, "2026-10-06");
    assert.equal(p.hour, 23);
    assert.equal(p.minute, 45);
    assert.equal(p.minutes, 23 * 60 + 45);
    // 00:15 Tehran on the 7th is 20:45 UTC on the 6th
    const after = new Date("2026-10-06T20:45:00Z");
    assert.equal(tehranYmd(after), "2026-10-07");
    assert.equal(tehranMinutesOfDay(after), 15);
    assert.equal(after.getUTCDate(), 6);
  });
  it("midnight is hour 0, never 24", () => {
    const p = tehranParts(new Date("2026-10-06T20:30:00Z"));
    assert.equal(p.hour, 0);
    assert.equal(p.ymd, "2026-10-07");
  });
  it("weekday in Tehran", () => {
    // 2026-10-09 is a Friday; 21:00 UTC Friday is already Saturday 00:30 in Tehran
    assert.equal(tehranWeekday(new Date("2026-10-09T10:00:00Z")), 5);
    assert.equal(tehranWeekday(new Date("2026-10-09T21:00:00Z")), 6);
    // shift index: Saturday = 0, Friday = 6
    assert.equal(tehranSaturdayDay(new Date("2026-10-09T21:00:00Z")), 0);
    assert.equal(tehranSaturdayDay(new Date("2026-10-09T10:00:00Z")), 6);
  });
  it("rejects an invalid date", () => {
    assert.throws(() => tehranParts(new Date("nope")));
  });
});

describe("offsets", () => {
  it("+03:30 now, +04:30 in an old summer (before 1402)", () => {
    assert.equal(tehranOffsetMinutes(new Date("2026-07-01T12:00:00Z")), 210);
    assert.equal(tehranOffsetMinutes(new Date("2026-01-01T12:00:00Z")), 210);
    assert.equal(tehranOffsetMinutes(new Date("2021-07-01T12:00:00Z")), 270);
  });
});

describe("fromTehranWallClock / day boundaries", () => {
  it("Tehran midnight is 20:30 UTC the day before", () => {
    assert.equal(iso(fromTehranWallClock("2026-10-07", 0)), "2026-10-06T20:30:00.000Z");
    assert.equal(iso(fromTehranWallClock(2026, 10, 7, 600)), "2026-10-07T06:30:00.000Z");
    assert.equal(iso(startOfTehranDay(new Date("2026-10-06T20:15:00Z"))), "2026-10-05T20:30:00.000Z");
    assert.equal(iso(startOfTehranDay(new Date("2026-10-06T20:45:00Z"))), "2026-10-06T20:30:00.000Z");
  });
  it("minutes past 24:00 roll into the next day", () => {
    assert.equal(iso(fromTehranWallClock("2026-10-07", 1440)), "2026-10-07T20:30:00.000Z");
  });
  it("old daylight-saving days", () => {
    // 2021-06-01 was +04:30
    assert.equal(iso(fromTehranWallClock("2021-06-01", 0)), "2021-05-31T19:30:00.000Z");
  });
  it("round trips", () => {
    for (const s of ["2026-03-20T20:29:59Z", "2026-03-20T20:30:00Z", "2026-12-31T21:00:00Z", "2025-06-15T00:00:00Z"]) {
      const d = new Date(s);
      const p = tehranParts(d);
      const back = fromTehranWallClock(p.ymd, p.minutes);
      assert.equal(back.getTime(), Math.floor(d.getTime() / 60000) * 60000, s);
    }
  });
  it("day range and calendar arithmetic", () => {
    const r = tehranDayRange(new Date("2026-10-06T22:00:00Z"));
    assert.equal(iso(r.start), "2026-10-06T20:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-07T20:30:00.000Z");
    assert.equal(iso(addTehranDays(new Date("2026-10-06T22:00:00Z"), 1)), "2026-10-07T20:30:00.000Z");
    assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysYmd("2024-03-01", -1), "2024-02-29");
    assert.equal(diffDaysYmd("2026-09-23", "2026-10-07"), 14);
    assert.equal(iso(endOfTehranDayYmd("2026-10-07")), "2026-10-07T20:29:59.999Z");
    assert.deepEqual(tehranDaysBetween(new Date("2026-10-06T21:00:00Z"), new Date("2026-10-08T19:00:00Z")), ["2026-10-07", "2026-10-08"]);
  });
});

describe("day keys (Reservation.date)", () => {
  // the same Tehran day saved at UTC midnight (server in UTC) or Tehran midnight
  const utcKey = new Date("2026-10-07T00:00:00Z");
  const tehranKey = new Date("2026-10-06T20:30:00Z");
  it("both conventions read as the same Tehran day", () => {
    assert.equal(tehranYmd(utcKey), "2026-10-07");
    assert.equal(tehranYmd(tehranKey), "2026-10-07");
    const r = tehranDayRange(tehranKey);
    assert.ok(utcKey >= r.start && utcKey < r.end);
    assert.ok(tehranKey >= r.start && tehranKey < r.end);
  });
  it("a visit at 10:00 starts at 10:00 Tehran for either key", () => {
    assert.equal(iso(tehranInstantOf(utcKey, 600)), "2026-10-07T06:30:00.000Z");
    assert.equal(iso(tehranInstantOf(tehranKey, 600)), "2026-10-07T06:30:00.000Z");
  });
  it("parseTehranDay: a day string, or a device's midnight", () => {
    assert.equal(iso(parseTehranDay("2026-10-07")!), "2026-10-06T20:30:00.000Z");
    // a browser in Tehran sent its midnight
    assert.equal(iso(parseTehranDay("2026-10-06T20:30:00.000Z")!), "2026-10-06T20:30:00.000Z");
    // a browser in UTC / New York sent its midnight of the 7th
    assert.equal(iso(parseTehranDay("2026-10-07T00:00:00.000Z")!), "2026-10-06T20:30:00.000Z");
    assert.equal(iso(parseTehranDay("2026-10-07T04:00:00.000Z")!), "2026-10-06T20:30:00.000Z");
    assert.equal(parseTehranDay("nope"), null);
    assert.equal(parseTehranDay(""), null);
  });
  it("dateUtils follows Tehran", () => {
    assert.equal(iso(dateStartOfDay(new Date("2026-10-07T00:00:00Z"))), "2026-10-06T20:30:00.000Z");
    assert.equal(tomorrowStart().getTime() - todayStart().getTime(), 864e5);
    assert.equal(tehranYmd(todayStart()), tehranYmd(new Date()));
    // Thursday 8 Oct to Saturday 10 Oct (Tehran): Thu=5, Fri=6, Sat=0
    assert.deepEqual(
      getDaysInRange(new Date("2026-10-07T21:00:00Z"), new Date("2026-10-10T08:00:00Z")).sort(),
      [0, 5, 6],
    );
    assert.equal(getSessionDateKey(new Date("2026-10-06T20:45:00Z")), "2026-10-07");
  });
  it("time off reads both conventions", () => {
    const records = [{ from: new Date("2026-10-07T00:00:00Z"), to: new Date("2026-10-08T00:00:00Z") }];
    assert.equal(blockedFrom(records, parseTehranDay("2026-10-07")!).wholeDay, true);
    assert.equal(blockedFrom(records, parseTehranDay("2026-10-08")!).wholeDay, true);
    assert.equal(blockedFrom(records, parseTehranDay("2026-10-09")!).wholeDay, false);
    assert.equal(blockedFrom(records, parseTehranDay("2026-10-06")!).wholeDay, false);
  });
  it("birth dates saved at either midnight", () => {
    assert.ok(sameCalendarDay(new Date("1990-05-01T00:00:00Z"), "1990-05-01"));
    // Tehran midnight (no daylight saving in 1990)
    assert.ok(sameCalendarDay(new Date("1990-04-30T20:30:00Z"), "1990-05-01"));
    // 2005-06-01 was a +04:30 summer
    assert.ok(sameCalendarDay(new Date("2005-05-31T19:30:00Z"), "2005-06-01"));
    assert.ok(!sameCalendarDay(new Date("1990-05-01T00:00:00Z"), "1990-05-02"));
  });
  it("a document dated today keeps its time, another day gets Tehran noon", () => {
    const now = new Date("2026-10-06T20:45:00Z"); // 00:15 on the 7th in Tehran
    assert.equal(tehranDocDate("2026-10-07", now), now);
    assert.equal(iso(tehranDocDate("2026-10-05", now)), "2026-10-05T08:30:00.000Z");
  });
});

describe("Jalali in Tehran", () => {
  it("the Esfand / Farvardin boundary (Nowruz 1405 = 2026-03-21)", () => {
    // 23:59 Tehran on 29 Esfand 1404 (20:29 UTC 2026-03-20)
    assert.deepEqual(tehranJalali(new Date("2026-03-20T20:29:00Z")), { jy: 1404, jm: 12, jd: 29 });
    // a minute later Tehran is in 1 Farvardin 1405, though UTC is still the 20th
    assert.deepEqual(tehranJalali(new Date("2026-03-20T20:30:00Z")), { jy: 1405, jm: 1, jd: 1 });
    assert.equal(tehranJalaliFormat(new Date("2026-03-20T20:30:00Z")), "1405/01/01");
    const y = jalaliYearRange(1405);
    assert.equal(iso(y.start), "2026-03-20T20:30:00.000Z");
    const esfand = jalaliMonthRange(1404, 12);
    assert.equal(esfand.days, 29);
    assert.equal(iso(esfand.end), iso(y.start));
    // month 13 rolls into the next year, month 0 into the previous
    assert.equal(iso(jalaliMonthRange(1404, 13).start), iso(y.start));
    assert.equal(iso(jalaliMonthRange(1405, 0).start), iso(esfand.start));
  });
  it("Mehr / Aban", () => {
    assert.equal(jalaliToYmd(1405, 8, 1), "2026-10-23");
    // 21:00 UTC on 22 Oct is already 1 Aban in Tehran
    assert.deepEqual(tehranJalali(new Date("2026-10-22T21:00:00Z")), { jy: 1405, jm: 8, jd: 1 });
    assert.equal(iso(startOfTehranJalaliMonth(new Date("2026-10-22T21:00:00Z"))), "2026-10-22T20:30:00.000Z");
    assert.equal(iso(startOfTehranJalaliMonth(new Date("2026-10-22T21:00:00Z"), -1)), "2026-09-22T20:30:00.000Z");
    const mehr = jalaliMonthRange(1405, 7);
    assert.equal(mehr.days, 30);
    assert.equal(iso(mehr.start), "2026-09-22T20:30:00.000Z");
  });
});
