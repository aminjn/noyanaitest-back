// Lib/publicHolidays.ts + Lib/publicHolidaySeed.ts (2026-10):
//   npx tsx --test Lib/__tests__/publicHolidays.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isClosedOn } from "../publicHolidays";
import { seedRows } from "../publicHolidaySeed";
import { blockedFrom } from "../timeOff";
import { fromTehranWallClock, parseTehranDay } from "../tehranTime";

describe("isClosedOn", () => {
  it("closed by default", () => {
    assert.equal(isClosedOn(null, "2026-11-13"), true);
    assert.equal(isClosedOn({ works: false, open: [], closed: [] }, "2026-11-13"), true);
  });
  it("the switch and a day against it", () => {
    assert.equal(isClosedOn({ works: true, open: [], closed: [] }, "2026-11-13"), false);
    assert.equal(isClosedOn({ works: true, open: [], closed: ["2026-11-13"] }, "2026-11-13"), true);
    assert.equal(isClosedOn({ works: false, open: ["2026-11-13"], closed: [] }, "2026-11-13"), false);
  });
});

describe("a closed holiday blocks the whole day", () => {
  it("like a day off, with its title", () => {
    const at = fromTehranWallClock("2026-11-13", 0);
    const b = blockedFrom([{ from: at, to: at, holiday: "شهادت حضرت فاطمه زهرا (س)" }], parseTehranDay("2026-11-13")!);
    assert.equal(b.wholeDay, true);
    assert.equal(b.holiday, "شهادت حضرت فاطمه زهرا (س)");
    assert.equal(blockedFrom([{ from: at, to: at, holiday: "x" }], parseTehranDay("2026-11-14")!).wholeDay, false);
  });
});

describe("seed", () => {
  const rows = seedRows();
  const day = (ymd: string) => rows.find((r) => r.ymd === ymd);
  it("fixed solar days land on their Gregorian days", () => {
    assert.ok(day("2026-03-21")?.title.includes("نوروز"));
    assert.ok(day("2027-02-11")?.title.includes("انقلاب"));
    assert.ok(day("2027-03-20")?.title.includes("نفت"));
    assert.ok(day("2028-03-19")?.title.includes("نفت"));
  });
  it("one row per day, two occasions joined", () => {
    assert.equal(new Set(rows.map((r) => r.ymd)).size, rows.length);
    assert.ok(day("2026-06-04")?.title.includes("غدیر"));
    assert.ok(day("2026-06-04")?.title.includes("خمینی"));
  });
  it("1405 has 26 holiday days", () => {
    assert.equal(rows.filter((r) => r.ymd >= "2026-03-21" && r.ymd <= "2027-03-20").length, 26);
  });
});
