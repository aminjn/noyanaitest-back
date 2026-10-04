// npx tsx --test Lib/business/__tests__/crmSalesCore.test.ts
// Ported from Nexxa's lib/__tests__/commission-core.test.ts and
// sales-planner-core.test.ts (vitest), plus the rule, assignment, blueprint,
// totals, period, duplicate and merge cores of the CRM sales side.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advancePeriod,
  applyTiers,
  collectCustomValues,
  commissionFor,
  DAY,
  dueInDaysFor,
  duplicateGroups,
  expectedPacePct,
  fieldKey,
  isReorderDue,
  leadTaskScore,
  matchAll,
  matchCondition,
  mergeFields,
  pickLeastLoaded,
  planTotals,
  priorityFromScore,
  purchaseCadence,
  ruleScore,
  stageMissing,
  type Tier,
} from "../crmSalesCore";

const TIERS: Tier[] = [
  { from: 0, pct: 2 },
  { from: 100_000_000, pct: 3 },
  { from: 500_000_000, pct: 5 },
];

describe("applyTiers (Nexxa commission-core)", () => {
  it("marginal: each slice at its own step", () => {
    assert.equal(applyTiers(300_000_000, TIERS, "marginal"), 8_000_000);
    assert.equal(applyTiers(600_000_000, TIERS, "marginal"), 19_000_000);
  });
  it("whole: the highest step reached on the whole amount", () => {
    assert.equal(applyTiers(300_000_000, TIERS, "whole"), 9_000_000);
    assert.equal(applyTiers(600_000_000, TIERS, "whole"), 30_000_000);
  });
  it("below the first threshold is zero", () => {
    const t: Tier[] = [{ from: 100_000_000, pct: 3 }];
    assert.equal(applyTiers(50_000_000, t, "marginal"), 0);
    assert.equal(applyTiers(50_000_000, t, "whole"), 0);
  });
  it("zero base or no tiers is zero; order of tiers does not matter", () => {
    assert.equal(applyTiers(0, TIERS, "marginal"), 0);
    assert.equal(applyTiers(1_000_000, [], "whole"), 0);
    assert.equal(applyTiers(300_000_000, [TIERS[2], TIERS[0], TIERS[1]], "marginal"), 8_000_000);
  });
  it("flat mode uses the flat percent", () => {
    assert.equal(commissionFor(10_000_000, 5, TIERS, "flat", "marginal"), 500_000);
    assert.equal(commissionFor(300_000_000, 5, TIERS, "tiered", "marginal"), 8_000_000);
  });
});

describe("conditions and rule score (Nexxa rules.ts / scoring.ts)", () => {
  const lead = { kind: "dental", value: 50_000_000, contactVisits: 4, contactCity: "تهران", title: "ایمپلنت دو واحد" };
  it("compares text, numbers (Persian digits too) and lists", () => {
    assert.ok(matchCondition(lead, { field: "kind", op: "eq", value: "DENTAL" }));
    assert.ok(matchCondition(lead, { field: "value", op: "gt", value: "۴۰۰۰۰۰۰۰" }));
    assert.ok(matchCondition(lead, { field: "kind", op: "in", value: "ivf، dental" }));
    assert.ok(matchCondition(lead, { field: "title", op: "contains", value: "ایمپلنت" }));
    assert.ok(!matchCondition(lead, { field: "contactSpent", op: "gt", value: "0" }));
    assert.ok(matchCondition(lead, { field: "contactSpent", op: "empty", value: "" }));
  });
  it("matchAll is AND and an empty list always matches", () => {
    assert.ok(matchAll(lead, []));
    assert.ok(!matchAll(lead, [{ field: "kind", op: "eq", value: "dental" }, { field: "contactVisits", op: "lt", value: "2" }]));
  });
  it("sums the points of matching active rules; none = 0", () => {
    const rules = [
      { field: "kind", op: "eq", value: "dental", points: 20 },
      { field: "contactVisits", op: "gt", value: "3", points: 15 },
      { field: "value", op: "gt", value: "100000000", points: 30 },
      { field: "kind", op: "eq", value: "dental", points: 50, active: false },
    ];
    assert.equal(ruleScore(lead, rules), 35);
    assert.equal(ruleScore(lead, []), 0);
  });
});

describe("assignment (Nexxa assign.ts / territory.ts)", () => {
  it("picks the least-loaded, ties to the earlier in the pool", () => {
    assert.equal(pickLeastLoaded(["a", "b", "c"], { a: 3, b: 1, c: 1 }), "b");
    assert.equal(pickLeastLoaded(["a", "b"], new Map()), "a");
    assert.equal(pickLeastLoaded([], {}), null);
  });
});

describe("stage blueprint", () => {
  it("lists the missing fields and the missing activity", () => {
    const rule = { requiredFields: ["value", "contact", "expectedClose"], requireActivity: true };
    assert.deepEqual(stageMissing({ value: 0, contact: "x" }, rule, 0), ["value", "expectedClose", "activity"]);
    assert.deepEqual(stageMissing({ value: 10, contact: "x", expectedClose: new Date() }, rule, 1), []);
    assert.deepEqual(stageMissing({}, null, 0), []);
  });
});

describe("plan totals", () => {
  it("line discount, then the plan's discount, then tax per line", () => {
    const t = planTotals(
      [
        { qty: 2, unitPrice: 1_000_000, discount: 10 },
        { qty: 1, unitPrice: 500_000, taxRate: 10 },
      ],
      10,
    );
    // line 1: 2,000,000 - 10% = 1,800,000 - 10% = 1,620,000
    // line 2: 500,000 - 10% = 450,000, tax 45,000
    assert.equal(t.subtotal, 2_500_000);
    assert.equal(t.discount, 2_500_000 - 1_620_000 - 450_000);
    assert.equal(t.tax, 45_000);
    assert.equal(t.total, 1_620_000 + 450_000 + 45_000);
  });
  it("clamps discount to 100 and tax to 50", () => {
    const t = planTotals([{ qty: 1, unitPrice: 100, discount: 300, taxRate: 90 }], 0);
    assert.equal(t.total, 0);
  });
});

describe("periods", () => {
  it("keeps the day and clamps to the month's end", () => {
    assert.equal(advancePeriod(new Date(Date.UTC(2026, 0, 31)), "month").toISOString().slice(0, 10), "2026-02-28");
    assert.equal(advancePeriod(new Date(Date.UTC(2026, 10, 15)), "month", 3).toISOString().slice(0, 10), "2027-02-15");
    assert.equal(advancePeriod(new Date(Date.UTC(2024, 1, 29)), "year").toISOString().slice(0, 10), "2025-02-28");
    assert.equal(advancePeriod(new Date(Date.UTC(2026, 0, 1)), "week", 2).toISOString().slice(0, 10), "2026-01-15");
  });
});

describe("planner (Nexxa sales-planner-core)", () => {
  const now = Date.UTC(2026, 5, 1);
  it("cadence: one purchase is 45 days; the mean gap otherwise, at least 7", () => {
    assert.equal(purchaseCadence([now]), 45);
    assert.equal(purchaseCadence([now - 60 * DAY, now - 30 * DAY, now]), 30);
    assert.equal(purchaseCadence([now - DAY, now]), 7);
  });
  it("due window and staleness", () => {
    const due = dueInDaysFor(now - 25 * DAY, 30, now);
    assert.equal(due, 5);
    assert.ok(isReorderDue(2, due, 30));
    assert.ok(!isReorderDue(2, 11, 30));
    assert.ok(!isReorderDue(1, -46, 45));
    assert.ok(isReorderDue(3, -59, 30));
    assert.ok(!isReorderDue(3, -61, 30));
  });
  it("pace and priority", () => {
    assert.equal(expectedPacePct(now, now + 15 * DAY, now + 30 * DAY), 50);
    assert.equal(expectedPacePct(now, now - DAY, now + 30 * DAY), 0);
    const hot = leadTaskScore(10, 100_000_000, 80, 60);
    const cold = leadTaskScore(0, 1_000, 0, 0);
    assert.ok(hot > cold);
    assert.equal(priorityFromScore(hot), 1);
    assert.equal(priorityFromScore(cold), 3);
  });
});

describe("duplicates and merge (Nexxa merge / duplicates)", () => {
  it("groups by national id, then account, then name + birth year", () => {
    const g = duplicateGroups([
      { id: "1", name: "علی رضایی", nationalId: "۰۰۱۲۳۴۵۶۷۸" },
      { id: "2", name: "Ali Rezaei", nationalId: "0012345678" },
      { id: "3", name: "مریم احمدی", user: "u1" },
      { id: "4", name: "مریم  احمدي", user: "u1" },
      { id: "5", name: "زهرا کریمی", birthYear: 1370 },
      { id: "6", name: "زهرا كريمی", birthYear: 1370 },
      { id: "7", name: "زهرا کریمی", birthYear: 1371 },
    ]);
    assert.deepEqual(
      g.map((x) => [x.reason, x.ids]),
      [
        ["nationalId", ["1", "2"]],
        ["user", ["3", "4"]],
        ["name", ["5", "6"]],
      ],
    );
  });
  it("fills blanks, joins tags, widens dates, keeps the opt-out", () => {
    const m = mergeFields(
      { name: "علی", tags: ["vip"], firstSeenAt: new Date("2026-03-01"), lastSeenAt: new Date("2026-03-05") },
      [
        { name: "Ali", city: "شیراز", tags: ["vip", "dental"], firstSeenAt: new Date("2025-01-01"), lastSeenAt: new Date("2026-04-01"), smsOptOut: true },
      ],
    );
    assert.equal(m.name, "علی");
    assert.equal(m.city, "شیراز");
    assert.deepEqual(m.tags, ["vip", "dental"]);
    assert.equal(m.firstSeenAt?.toISOString().slice(0, 10), "2025-01-01");
    assert.equal(m.lastSeenAt?.toISOString().slice(0, 10), "2026-04-01");
    assert.equal(m.smsOptOut, true);
  });
});

describe("custom fields (Nexxa customfields.ts)", () => {
  it("makes a unique key", () => {
    assert.equal(fieldKey("Blood type", []), "blood_type");
    assert.equal(fieldKey("Blood type", ["blood_type"]), "blood_type_2");
    assert.equal(fieldKey("گروه خونی", []), "field");
  });
  it("keeps inactive values, removes a cleared active one", () => {
    const out = collectCustomValues({ a: "", b: true }, [
      { key: "a", type: "text" },
      { key: "b", type: "checkbox" },
    ], { a: "old", z: "kept" });
    assert.deepEqual(out, { z: "kept", b: "1" });
  });
});
