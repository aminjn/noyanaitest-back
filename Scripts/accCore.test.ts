// The port of Nexxa's vitest suites for the accounting cores
// (src/lib/__tests__: depreciation-core, bank-match-core, allocation-core,
// tree-cycle-core, account-rollup-core) plus the year-end, trial-balance,
// seasonal-169, coding-import and treasury-policy cores of Lib/business/
// accCore.ts. Built with the backend (npx tsc) and run with
//   node --test compile/Scripts/accCore.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRevaluation,
  createsCycle,
  depreciationForMonths,
  distribute,
  groupByParty,
  groupPermanentClosing,
  matchStatement,
  negativeCheck,
  ParentMap,
  parseCoding,
  partyKey,
  reverseClosingToOpening,
  rollupTurnover,
  subtreeAccountIds,
  totals,
  trialRow,
  wholeMonths,
  wholeJalaliMonths,
  DepAsset,
  BookLine,
  StmtLine,
  computeVatReturn,
  depreciationBetween,
  depreciationUntil,
  jalaliMonthIndex,
  serviceStartIndex,
  IRAN_DEP_PRESETS,
} from "../Lib/business/accCore";

const straight = (over: Partial<DepAsset> = {}): DepAsset => ({ cost: 120_000_000, salvageValue: 0, usefulLifeYears: 5, method: "straight", decliningRate: 0, accumulatedDep: 0, ...over });

describe("wholeMonths", () => {
  it("whole months elapsed", () => {
    assert.equal(wholeMonths(new Date(2025, 0, 1), new Date(2025, 3, 15)), 3);
    assert.equal(wholeMonths(new Date(2025, 5, 1), new Date(2025, 5, 20)), 0);
    assert.equal(wholeMonths(new Date(2025, 5, 1), new Date(2024, 0, 1)), 0);
  });
});

describe("wholeJalaliMonths", () => {
  it("Jalali months as Tehran sees them", () => {
    // 1 Mehr 1405 (2026-09-23) to 9 Mehr (2026-10-01): the same month
    assert.equal(wholeJalaliMonths(new Date("2026-09-23T08:00:00Z"), new Date("2026-10-01T08:00:00Z")), 0);
    // to 1 Aban (2026-10-23): one month
    assert.equal(wholeJalaliMonths(new Date("2026-09-23T08:00:00Z"), new Date("2026-10-23T08:00:00Z")), 1);
    // 21:00 UTC on 22 Oct is already 1 Aban in Tehran
    assert.equal(wholeJalaliMonths(new Date("2026-09-23T08:00:00Z"), new Date("2026-10-22T21:00:00Z")), 1);
    assert.equal(wholeJalaliMonths(new Date("2026-10-23T08:00:00Z"), new Date("2026-09-23T08:00:00Z")), 0);
  });
});

describe("straight line", () => {
  it("monthly = (cost - salvage) / (life x 12)", () => assert.equal(depreciationForMonths(straight(), 3), 6_000_000));
  it("with salvage", () => assert.equal(depreciationForMonths(straight({ salvageValue: 20_000_000 }), 12), 20_000_000));
  it("never beyond the depreciable amount", () => assert.equal(depreciationForMonths(straight({ accumulatedDep: 118_000_000 }), 10), 2_000_000));
  it("zero months is zero", () => assert.equal(depreciationForMonths(straight(), 0), 0));
});

describe("declining (ماده‌ی ۱۴۹: the yearly rate on the year's opening book value)", () => {
  it("a twelfth of the yearly rate a month", () => {
    assert.equal(depreciationForMonths(straight({ cost: 100_000_000, method: "declining", decliningRate: 24 }), 1), 2_000_000);
  });
  it("the same every month of a year, the full rate over twelve", () => {
    const a = straight({ cost: 100_000_000, method: "declining", decliningRate: 24 });
    assert.equal(depreciationForMonths(a, 2), 4_000_000);
    assert.equal(depreciationForMonths(a, 12), 24_000_000);
  });
  it("the next year on the lower book value", () => {
    const a = straight({ cost: 100_000_000, method: "declining", decliningRate: 24 });
    // year 1: 24m; year 2: 24% of 76m = 18.24m
    assert.equal(depreciationForMonths(a, 24), 24_000_000 + 18_240_000);
  });
  it("a run picked up mid-year continues at that year's rate", () => {
    const a = straight({ cost: 100_000_000, method: "declining", decliningRate: 24 });
    const whole = depreciationBetween(a, 0, 12, 0);
    const first = depreciationBetween(a, 0, 5, 0);
    const rest = depreciationBetween({ ...a, accumulatedDep: first }, 5, 12, 0);
    assert.equal(first + rest, whole);
  });
  it("a first year that starts mid-year gets its months' share", () => {
    // ready in Mehr (month index 6 of the year): six months of 7%
    const a = straight({ cost: 120_000_000, method: "declining", decliningRate: 7 });
    assert.equal(depreciationBetween(a, 6, 12, 6), 4_200_000);
    // the next year: 7% of 115.8m
    assert.equal(depreciationBetween({ ...a, accumulatedDep: 4_200_000 }, 12, 24, 6), 8_106_000);
  });
  it("below 5% of cost, the rest goes in full the next year", () => {
    const a = straight({ cost: 100_000_000, accumulatedDep: 96_000_000, method: "declining", decliningRate: 25 });
    assert.equal(depreciationBetween(a, 12, 13, 0), 4_000_000);
    assert.equal(depreciationBetween({ ...a, accumulatedDep: 100_000_000 }, 24, 36, 0), 0);
  });
  it("not below salvage", () => {
    const a = straight({ cost: 100_000_000, salvageValue: 95_000_000, method: "declining", decliningRate: 50 });
    assert.ok(depreciationForMonths(a, 240) <= 5_000_000);
  });
});

describe("start month (ماده‌ی ۱۴۹: from the month the asset is ready for use)", () => {
  // 1 Mehr 1405 = 2026-09-23; 15 Mehr = 2026-10-07; 1 Aban = 2026-10-23
  it("ready on the 1st: that month counts", () => {
    assert.equal(serviceStartIndex(new Date("2026-09-23T08:00:00Z")), jalaliMonthIndex(new Date("2026-09-23T08:00:00Z")));
  });
  it("ready mid-month: the next month is the first", () => {
    assert.equal(serviceStartIndex(new Date("2026-10-07T08:00:00Z")), jalaliMonthIndex(new Date("2026-10-23T08:00:00Z")));
  });
  it("bought on 15 Mehr: nothing on 1 Aban, Aban's month on 1 Azar", () => {
    const a = { ...straight(), acquisitionDate: new Date("2026-10-07T08:00:00Z") };
    assert.equal(depreciationUntil(a, new Date("2026-10-23T08:00:00Z")), 0);
    // 1 Azar 1405 = 2026-11-22
    assert.equal(depreciationUntil(a, new Date("2026-11-22T08:00:00Z")), 2_000_000);
  });
  it("the in-service date wins over the purchase date", () => {
    const a = { ...straight(), acquisitionDate: new Date("2026-09-23T08:00:00Z"), inServiceDate: new Date("2026-10-23T08:00:00Z") };
    assert.equal(depreciationUntil(a, new Date("2026-11-22T08:00:00Z")), 2_000_000);
  });
  it("after a run, the months since it", () => {
    const a = { ...straight(), acquisitionDate: new Date("2026-09-23T08:00:00Z"), lastDepDate: new Date("2026-11-22T08:00:00Z"), accumulatedDep: 4_000_000 };
    // run on 1 Dey (2026-12-22): Azar only
    assert.equal(depreciationUntil(a, new Date("2026-12-22T08:00:00Z")), 2_000_000);
  });
});

describe("Iranian presets", () => {
  it("each has a usable method", () => {
    for (const p of IRAN_DEP_PRESETS) {
      assert.ok(p.usefulLifeYears >= 1, p.key);
      if (p.method === "declining") assert.ok(p.decliningRate > 0 && p.decliningRate < 100, p.key);
      else assert.equal(p.decliningRate, 0, p.key);
    }
  });
  it("medical equipment is the 8-year row (group 18, row 3)", () => {
    const m = IRAN_DEP_PRESETS.find((p) => p.key === "medical")!;
    assert.equal(m.usefulLifeYears, 8);
    assert.deepEqual(m.ref, { group: 18, row: 3 });
  });
  it("keys are unique", () => assert.equal(new Set(IRAN_DEP_PRESETS.map((p) => p.key)).size, IRAN_DEP_PRESETS.length));
});

describe("revaluation", () => {
  it("an increase keeps the depreciated share and goes to surplus", () => {
    const r = computeRevaluation({ cost: 100, accumulatedDep: 40 }, 90, 0);
    assert.equal(r.newCost - r.newAccum, 90);
    assert.equal(r.equityUp, 30);
    assert.equal(r.expense, 0);
    assert.equal(r.costDelta - r.accumDelta, r.surplus);
  });
  it("a decrease reverses prior surplus first, the rest is expense", () => {
    const r = computeRevaluation({ cost: 100, accumulatedDep: 40 }, 40, 5);
    assert.equal(r.equityDown, 5);
    assert.equal(r.expense, 15);
  });
});

const D = (s: string) => new Date(s).getTime();
describe("bank statement matching", () => {
  it("exact amount and date", () => {
    const r = matchStatement([{ id: "a", date: D("2026-07-01"), amount: 1000 }], [{ date: D("2026-07-01"), amount: 1000 }]);
    assert.deepEqual(r.matches, [{ stmtIndex: 0, bookId: "a", dayDiff: 0 }]);
    assert.deepEqual(r.unmatchedStmt, []);
    assert.deepEqual(r.unmatchedBook, []);
  });
  it("within the window", () => {
    const r = matchStatement([{ id: "a", date: D("2026-07-05"), amount: -500 }], [{ date: D("2026-07-03"), amount: -500 }], 5);
    assert.equal(r.matches[0].bookId, "a");
    assert.equal(r.matches[0].dayDiff, 2);
  });
  it("outside the window", () => {
    const r = matchStatement([{ id: "a", date: D("2026-07-20"), amount: 500 }], [{ date: D("2026-07-01"), amount: 500 }], 5);
    assert.deepEqual(r.matches, []);
    assert.deepEqual(r.unmatchedStmt, [0]);
    assert.deepEqual(r.unmatchedBook, ["a"]);
  });
  it("the closest date wins", () => {
    const book: BookLine[] = [
      { id: "far", date: D("2026-07-04"), amount: 200 },
      { id: "near", date: D("2026-07-02"), amount: 200 },
    ];
    const r = matchStatement(book, [{ date: D("2026-07-01"), amount: 200 }]);
    assert.equal(r.matches[0].bookId, "near");
    assert.deepEqual(r.unmatchedBook, ["far"]);
  });
  it("one to one", () => {
    const book: BookLine[] = [
      { id: "a", date: D("2026-07-01"), amount: 100 },
      { id: "b", date: D("2026-07-10"), amount: 100 },
    ];
    const stmt: StmtLine[] = [
      { date: D("2026-07-01"), amount: 100 },
      { date: D("2026-07-10"), amount: 100 },
    ];
    const r = matchStatement(book, stmt);
    assert.equal(r.matches.length, 2);
    assert.deepEqual(new Set(r.matches.map((m) => m.bookId)), new Set(["a", "b"]));
  });
  it("deposit is not withdrawal", () => {
    assert.deepEqual(matchStatement([{ id: "a", date: D("2026-07-01"), amount: 100 }], [{ date: D("2026-07-01"), amount: -100 }]).matches, []);
  });
});

describe("distribute", () => {
  it("50/30/20", () => assert.deepEqual(distribute(1_000_000, [50, 30, 20]), [500_000, 300_000, 200_000]));
  it("always sums to the amount", () => assert.equal(distribute(1_000_000, [33.33, 33.33, 33.34]).reduce((s, x) => s + x, 0), 1_000_000));
  it("proportional when not 100", () => assert.deepEqual(distribute(900, [1, 1, 1]), [300, 300, 300]));
  it("zero", () => {
    assert.deepEqual(distribute(0, [50, 50]), [0, 0]);
    assert.deepEqual(distribute(1000, [0, 0]), [0, 0]);
  });
  it("odd amounts", () => assert.equal(distribute(1_000_001, [50, 50]).reduce((s, x) => s + x, 0), 1_000_001));
});

const parents = (): ParentMap =>
  new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["d", null],
  ]);
describe("createsCycle", () => {
  it("root is fine", () => assert.equal(createsCycle(parents(), "b", null), false));
  it("self", () => assert.equal(createsCycle(parents(), "b", "b"), true));
  it("child as parent", () => assert.equal(createsCycle(parents(), "a", "b"), true));
  it("deep", () => assert.equal(createsCycle(parents(), "a", "c"), true));
  it("unrelated", () => {
    assert.equal(createsCycle(parents(), "d", "c"), false);
    assert.equal(createsCycle(parents(), "c", "d"), false);
  });
  it("move a subtree", () => assert.equal(createsCycle(parents(), "c", "a"), false));
  it("unknown parent", () => assert.equal(createsCycle(parents(), "b", "zzz"), false));
  it("looped data does not spin", () => {
    const looped: ParentMap = new Map([
      ["x", "y"],
      ["y", "x"],
      ["z", null],
    ]);
    assert.equal(createsCycle(looped, "z", "x"), false);
    assert.equal(createsCycle(looped, "x", "y"), true);
  });
});

const tree = [
  { id: "1", parentId: null },
  { id: "12", parentId: "1" },
  { id: "1200", parentId: "12" },
  { id: "1200-1", parentId: "1200" },
  { id: "1200-1-a", parentId: "1200-1" },
  { id: "1210", parentId: "12" },
  { id: "2", parentId: null },
  { id: "2100", parentId: "2" },
];
describe("subtree and rollup", () => {
  it("root and descendants", () => assert.deepEqual([...subtreeAccountIds("1200", tree)].sort(), ["1200", "1200-1", "1200-1-a"]));
  it("missing root", () => assert.equal(subtreeAccountIds("9999", tree).size, 0));
  it("cycle-safe", () => {
    const ids = subtreeAccountIds("a", [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "a" },
    ]);
    assert.ok(ids.has("a") && ids.has("c"));
  });
  const lines = [
    { accountId: "1200", debit: 1000, credit: 0 },
    { accountId: "1200-1", debit: 500, credit: 200 },
    { accountId: "1200-1-a", debit: 40, credit: 0 },
    { accountId: "1210", debit: 700, credit: 0 },
    { accountId: "2100", debit: 0, credit: 900 },
    { accountId: "orphan", debit: 123, credit: 456 },
  ];
  it("rolls up", () => assert.deepEqual(rollupTurnover("1200", tree, lines), { debit: 1540, credit: 200 }));
  it("orphans not counted", () => assert.deepEqual(rollupTurnover("1", tree, lines), { debit: 2240, credit: 200 }));
});

describe("year end per tafsili", () => {
  const ledger = [
    { accountId: "recv", tafsiliId: "p1", costCenterId: null, debit: 500, credit: 0 },
    { accountId: "recv", tafsiliId: "p2", costCenterId: null, debit: 300, credit: 100 },
    { accountId: "cap", tafsiliId: null, costCenterId: null, debit: 0, credit: 700 },
  ];
  const close = groupPermanentClosing(ledger, (id) => id);
  it("one line per account x party, balanced", () => {
    assert.equal(close.length, 3);
    const t = totals(close);
    assert.equal(t.debit, t.credit);
  });
  it("opening reverses the closing, parties kept", () => {
    const open = reverseClosingToOpening(close);
    const p2 = open.find((l) => l.tafsiliId === "p2")!;
    assert.equal(p2.debit, 200);
  });
});

describe("trial row", () => {
  it("nets opening and closing, grosses turnover", () => {
    const r = trialRow({ code: "1", name: "x", openD: 100, openC: 30, turnD: 50, turnC: 200 });
    assert.equal(r.openDebit, 70);
    assert.equal(r.closeCredit, 80);
    assert.equal(r.cumDebit, 150);
  });
});

describe("seasonal 169", () => {
  it("groups by national id, not name", () => {
    const rows = groupByParty([
      { net: 100, vat: 10, party: { name: "علی", nationalId: "1" } },
      { net: 50, vat: 5, party: { name: "علی", nationalId: "2" } },
      { net: 25, vat: 0, party: { name: "علی", nationalId: "1" } },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].amount, 125);
  });
  it("key order", () => {
    assert.equal(partyKey({ name: "x", economicCode: "9" }), "ec:9");
    assert.equal(partyKey({ name: "x" }), "nm:x");
  });
  it("vat return", () => {
    const r = computeVatReturn([{ net: 100, vat: 10, party: { name: "a" } }], [{ net: 300, vat: 30, party: { name: "b" } }]);
    assert.equal(r.vatPayable, 0);
    assert.equal(r.creditCarryforward, 20);
  });
});

describe("coding import", () => {
  it("levels and parents from codes, Persian digits too", () => {
    const rows = parseCoding("1 دارایی‌ها\n۱۱ موجودی نقد\n1101 صندوق\n7 هزینه‌ها");
    assert.equal(rows.length, 4);
    assert.equal(rows[2].level, "detail");
    assert.equal(rows[2].parent, "11");
    assert.equal(rows[3].type, "expense");
  });
});

describe("negative treasury policy", () => {
  it("allow / warn / block", () => {
    assert.equal(negativeCheck("allow", 0, 100), "ok");
    assert.equal(negativeCheck("warn", 50, 100), "warn");
    assert.equal(negativeCheck("block", 50, 100), "block");
    assert.equal(negativeCheck("block", 150, 100), "ok");
  });
});
