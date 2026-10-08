// Lib/openingHours.ts: "open now" in Tehran whatever the process zone.
//   npx tsx --test Lib/__tests__/openingHours.test.ts
//   TZ=America/New_York npx tsx --test Lib/__tests__/openingHours.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenAt,
  isRoundTheClockHours,
  normalizeOpeningHours,
  openStatusAt,
  openingHoursSpecification,
  parseLegacyHours,
  roundTheClockDays,
  weekIntervalsOf,
  tehranWeekMinute,
} from "../openingHours";
import { fromTehranWallClock } from "../tehranTime";

// 2026-10-10 is a Saturday
const at = (ymd: string, hh: number, mm = 0) => fromTehranWallClock(ymd, hh * 60 + mm);
const NOW = at("2026-10-10", 9);
const daily = (ranges: { start: number; end: number }[]) =>
  normalizeOpeningHours({ days: Array.from({ length: 7 }, () => ({ ranges })) }, NOW)!;

describe("normalize", () => {
  it("accepts HH:MM, merges overlaps and keeps one overnight range", () => {
    const h = normalizeOpeningHours(
      { days: Array.from({ length: 7 }, () => ({ ranges: [{ start: "08:00", end: "14:00" }, { start: "12:00", end: "02:00" }] })) },
      NOW,
    )!;
    assert.deepEqual(h.days[0].ranges, [{ start: 480, end: 120 }]);
  });
  it("rejects a wrong week and bad ranges", () => {
    assert.throws(() => normalizeOpeningHours({ days: [{ ranges: [] }] }, NOW));
    assert.throws(() => normalizeOpeningHours({ days: Array.from({ length: 7 }, () => ({ ranges: [{ start: "25:00", end: "26:00" }] })) }, NOW));
  });
  it("empty is null", () => assert.equal(normalizeOpeningHours({ days: [], exceptions: [] }, NOW), null));
  it("drops old exceptions", () => {
    const h = normalizeOpeningHours({ days: [], exceptions: [{ date: "2026-01-01", ranges: [] }, { date: "2026-10-12", ranges: [] }] }, NOW)!;
    assert.deepEqual(h.exceptions.map((e) => e.date), ["2026-10-12"]);
  });
});

describe("isOpenAt / openStatusAt", () => {
  const h = daily([{ start: 480, end: 1320 }]);
  it("open in the range, closed outside", () => {
    assert.equal(isOpenAt(h, at("2026-10-10", 9)), true);
    assert.equal(isOpenAt(h, at("2026-10-10", 22)), false);
    assert.equal(isOpenAt(h, at("2026-10-10", 7, 59)), false);
  });
  it("closes at 22:00 / opens tomorrow 08:00", () => {
    assert.deepEqual(openStatusAt(h, at("2026-10-10", 9)), { open: true, closesAt: { dayOffset: 0, minutes: 1320, day: 0 } });
    assert.deepEqual(openStatusAt(h, at("2026-10-10", 23)), { open: false, opensAt: { dayOffset: 1, minutes: 480, day: 1 } });
  });
  it("overnight 20:00-02:00 is open at 01:00 the next day", () => {
    const n = daily([{ start: 1200, end: 120 }]);
    assert.equal(isOpenAt(n, at("2026-10-11", 1)), true);
    assert.equal(isOpenAt(n, at("2026-10-11", 3)), false);
    assert.deepEqual(openStatusAt(n, at("2026-10-10", 21))?.closesAt, { dayOffset: 1, minutes: 120, day: 1 });
  });
  it("closes at 24:00 reads as today 24:00", () => {
    const n = daily([{ start: 480, end: 1440 }]);
    assert.deepEqual(openStatusAt(n, at("2026-10-10", 23))?.closesAt, { dayOffset: 0, minutes: 1440, day: 0 });
  });
  it("round the clock is allDay; a closed holiday wins", () => {
    const r = normalizeOpeningHours({ days: roundTheClockDays(), exceptions: [{ date: "2026-10-12", ranges: [] }] }, NOW)!;
    assert.equal(isRoundTheClockHours(r), true);
    assert.equal(openStatusAt(r, at("2026-10-10", 3))?.open, true);
    assert.equal(openStatusAt(r, at("2026-10-10", 3))?.closesAt?.dayOffset, 1);
    assert.equal(isOpenAt(r, at("2026-10-12", 10)), false);
    const plain = normalizeOpeningHours({ days: roundTheClockDays() }, NOW)!;
    assert.deepEqual(openStatusAt(plain, NOW), { open: true, allDay: true });
  });
  it("closed Friday skips to Saturday", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ ranges: i === 6 ? [] : [{ start: 480, end: 1320 }] }));
    const w = normalizeOpeningHours({ days }, NOW)!;
    // Thursday 2026-10-15 23:00
    assert.deepEqual(openStatusAt(w, at("2026-10-15", 23))?.opensAt, { dayOffset: 2, minutes: 480, day: 0 });
  });
  it("no hours: null / false", () => {
    assert.equal(openStatusAt(undefined, NOW), null);
    assert.equal(isOpenAt({ days: [] }, NOW), false);
  });
});

describe("week intervals", () => {
  it("Friday overnight wraps to Saturday morning", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ ranges: i === 6 ? [{ start: 1200, end: 120 }] : [] }));
    assert.deepEqual(weekIntervalsOf(days), [{ s: 0, e: 120 }, { s: 6 * 1440 + 1200, e: 7 * 1440 }]);
  });
  it("Saturday 09:00 Tehran is minute 540", () => assert.equal(tehranWeekMinute(NOW), 540));
});

describe("legacy text", () => {
  it("parses simple patterns", () => {
    assert.equal(parseLegacyHours("شبانه روزی")?.roundTheClock, true);
    assert.equal(parseLegacyHours("شبانه‌روزی")?.roundTheClock, true);
    assert.deepEqual(parseLegacyHours("۸ تا ۲۲")?.days[0].ranges, [{ start: 480, end: 1320 }]);
    assert.deepEqual(parseLegacyHours("8-22")?.days[3].ranges, [{ start: 480, end: 1320 }]);
    assert.deepEqual(parseLegacyHours("از ساعت ۸ صبح تا ۱۰ شب")?.days[0].ranges, [{ start: 480, end: 1320 }]);
    assert.deepEqual(parseLegacyHours("8:30-13 و 16-21")?.days[0].ranges, [{ start: 510, end: 780 }, { start: 960, end: 1260 }]);
    assert.deepEqual(parseLegacyHours("20 تا 2")?.days[0].ranges, [{ start: 1200, end: 120 }]);
  });
  it("leaves the rest", () => {
    assert.equal(parseLegacyHours("شنبه تا چهارشنبه ۸ تا ۱۴"), null);
    assert.equal(parseLegacyHours("تماس بگیرید"), null);
    assert.equal(parseLegacyHours(""), null);
  });
});

describe("schema.org", () => {
  it("one entry per range", () => {
    const spec = openingHoursSpecification(daily([{ start: 480, end: 1440 }]), NOW)!;
    assert.equal(spec.length, 7);
    assert.deepEqual(spec[0], { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Saturday", opens: "08:00", closes: "23:59" });
  });
});
