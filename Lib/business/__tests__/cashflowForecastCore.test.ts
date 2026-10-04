// npx tsx --test Lib/business/__tests__/*.test.ts
// Ported from Nexxa's lib/__tests__/cashflow-forecast-core.test.ts (vitest)
// to node:test, which needs no extra dependency.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lowestPoint, monthlyPeriods, projectCashflow, type DatedFlow, type Period } from "../cashflowForecastCore";

const D = (s: string) => new Date(s).getTime();

describe("Cash-flow forecast core", () => {
  const periods: Period[] = [
    { label: "m1", start: D("2026-08-01"), end: D("2026-09-01") },
    { label: "m2", start: D("2026-09-01"), end: D("2026-10-01") },
  ];

  it("adds the flows period by period to the opening balance", () => {
    const flows: DatedFlow[] = [
      { date: D("2026-08-10"), amount: 500 },
      { date: D("2026-08-20"), amount: -200 },
      { date: D("2026-09-15"), amount: 300 },
    ];
    const r = projectCashflow(1000, flows, periods);
    assert.deepEqual(r[0], { label: "m1", inflow: 500, outflow: 200, net: 300, balance: 1300, negative: false });
    assert.equal(r[1].inflow, 300);
    assert.equal(r[1].outflow, 0);
    assert.equal(r[1].balance, 1600);
  });

  it("flags a negative balance and carries it forward", () => {
    const r = projectCashflow(1000, [{ date: D("2026-08-05"), amount: -1500 }], periods);
    assert.equal(r[0].balance, -500);
    assert.equal(r[0].negative, true);
    assert.equal(r[1].negative, true);
  });

  it("ignores a flow outside every period", () => {
    const r = projectCashflow(0, [{ date: D("2026-07-01"), amount: 9999 }, { date: D("2026-12-01"), amount: 9999 }], periods);
    assert.equal(r[0].net, 0);
    assert.equal(r[1].net, 0);
  });

  it("treats the period's end as exclusive", () => {
    const r = projectCashflow(0, [{ date: D("2026-09-01"), amount: 100 }], periods);
    assert.equal(r[0].inflow, 0);
    assert.equal(r[1].inflow, 100);
  });

  it("monthlyPeriods builds the boundaries and labels", () => {
    const starts = [D("2026-08-01"), D("2026-09-01")];
    const p = monthlyPeriods(starts, ["a", "b"]);
    assert.equal(p.length, 2);
    assert.deepEqual(p[0], { label: "a", start: starts[0], end: starts[1] });
  });

  it("lowestPoint finds a dip inside a period that ends positive", () => {
    const flows: DatedFlow[] = [
      { date: D("2026-08-05"), amount: -800 },
      { date: D("2026-08-20"), amount: 900 },
    ];
    const low = lowestPoint(500, flows, D("2026-08-01"), D("2026-09-01"));
    assert.equal(low.balance, -300);
    assert.equal(low.date, D("2026-08-05"));
  });
});
