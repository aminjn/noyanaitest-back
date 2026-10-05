// npx tsx --test Lib/business/__tests__/payrollTax.test.ts
// The salary tax figures of 1405 (قانون بودجه‌ی ۱۴۰۵: معافیت ماهانه
// ۴۰٬۰۰۰٬۰۰۰ تومان، نرخ‌های ۱۰ تا ۳۰ درصد) and the months-worked column of
// the WH file (docs/tax-verification-1405.md in the frontend repo).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { progressiveTax } from "../payroll";
import { monthsWorkedInYear, validNationalId } from "../taxDisk";

const BRACKETS_1405 = [
  { upTo: 80_000_000, rate: 10 },
  { upTo: 100_000_000, rate: 15 },
  { upTo: 120_000_000, rate: 20 },
  { upTo: 140_000_000, rate: 25 },
  { upTo: null, rate: 30 },
];
const tax = (taxable: number) => progressiveTax(taxable, 40_000_000, BRACKETS_1405);

describe("salary tax 1405 (toman a month)", () => {
  it("up to the exemption, nothing", () => assert.equal(tax(40_000_000), 0));
  it("the first slice at 10%", () => assert.equal(tax(60_000_000), 2_000_000));
  it("each slice at its own rate", () => {
    // 40m x 10% + 20m x 15% + 20m x 20% + 20m x 25% + 10m x 30%
    assert.equal(tax(150_000_000), 4_000_000 + 3_000_000 + 4_000_000 + 5_000_000 + 3_000_000);
  });
});

// 1 Farvardin 1405 = 2026-03-21; 15 Tir 1405 = 2026-07-06; 1 Mehr = 2026-09-23
describe("months worked this year (WH)", () => {
  it("hired in an earlier year: every month so far", () => assert.equal(monthsWorkedInYear(1405, 7, new Date("2024-05-01T08:00:00Z"), 1), 7));
  it("hired this year mid-month: that month counts", () => assert.equal(monthsWorkedInYear(1405, 7, new Date("2026-07-06T08:00:00Z"), 1), 4));
  it("hired on the list's month", () => assert.equal(monthsWorkedInYear(1405, 7, new Date("2026-09-23T08:00:00Z"), 1), 1));
  it("never fewer than the months on Noyan's payroll", () => assert.equal(monthsWorkedInYear(1405, 7, new Date("2026-09-23T08:00:00Z"), 3), 3));
  it("never more than the list's month", () => assert.equal(monthsWorkedInYear(1405, 2, undefined, 5), 2));
  it("no start date: the list's month", () => assert.equal(monthsWorkedInYear(1405, 7, undefined, 1), 7));
});

describe("national code", () => {
  it("check digit", () => {
    assert.equal(validNationalId("0499370899"), true);
    assert.equal(validNationalId("0499370898"), false);
    assert.equal(validNationalId("1111111111"), false);
  });
});
