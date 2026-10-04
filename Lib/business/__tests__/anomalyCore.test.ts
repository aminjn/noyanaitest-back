// npx tsx --test Lib/business/__tests__/*.test.ts
// Ported from Nexxa's lib/__tests__/anomaly-core.test.ts (vitest).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, type Txn } from "../anomalyCore";

const base = (id: string, amount: number, over: Partial<Txn> = {}): Txn => ({
  id,
  amount,
  accountCode: "7201",
  accountType: "expense",
  date: new Date("2026-07-01").getTime(),
  isFriday: false,
  hasCostCenter: true,
  label: "",
  ...over,
});
const day = 86_400_000;

describe("Anomaly detection core", () => {
  it("finds an outlier against its account type", () => {
    const r = detectAnomalies([base("a", 100), base("b", 110), base("c", 90), base("d", 105), base("e", 95), base("outlier", 100000)]);
    assert.ok(r.some((x) => x.id === "outlier"));
  });

  it("reports no outlier below 5 lines", () => {
    const r = detectAnomalies([base("a", 100), base("b", 99999)]);
    assert.ok(!r.some((x) => x.reason === "faiAnOutlier"));
  });

  it("finds a probable duplicate (same account and amount within days)", () => {
    const t0 = new Date("2026-07-01").getTime();
    const r = detectAnomalies([base("x1", 500, { accountCode: "1101", date: t0 }), base("x2", 500, { accountCode: "1101", date: t0 + 2 * day })]);
    assert.ok(r.some((x) => x.id === "x2" && x.reason === "faiAnDuplicate"));
  });

  it("does not call far-apart entries duplicates", () => {
    const t0 = new Date("2026-07-01").getTime();
    const r = detectAnomalies([base("x1", 500, { accountCode: "1101", date: t0 }), base("x2", 500, { accountCode: "1101", date: t0 + 10 * day })]);
    assert.ok(!r.some((x) => x.reason === "faiAnDuplicate"));
  });

  it("flags a large expense without a cost centre", () => {
    const r = detectAnomalies([base("s1", 100), base("s2", 100), base("s3", 100), base("s4", 100), base("s5", 100), base("big", 5000, { hasCostCenter: false })]);
    assert.ok(r.some((x) => x.id === "big"));
  });

  it("sorts by severity (high before low)", () => {
    const r = detectAnomalies([base("n1", 100), base("n2", 100), base("n3", 100), base("n4", 100), base("n5", 100), base("huge", 1_000_000)]);
    assert.ok(r.length > 0);
    assert.equal(r[0].severity, "high");
  });
});
