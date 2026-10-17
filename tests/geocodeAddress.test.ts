import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { addressVariants } from "../Lib/geocodeAddress";

// An Iranian address is tried as written, then without its plaque / unit,
// then shortened from its end (2026-10: the owner's «میدان انقلاب، ابتدای
// کارگر جنوبی، نبش کوچه رشتچی، پلاک ۹۷۴» found nothing as written).

describe("address variants", () => {
  test("drops the plaque, then the last parts, then the connector words", () => {
    const v = addressVariants("میدان انقلاب، ابتدای کارگر جنوبی، نبش کوچه رشتچی، پلاک ۹۷۴");
    assert.deepEqual(v.slice(0, 4), [
      "میدان انقلاب، ابتدای کارگر جنوبی، نبش کوچه رشتچی، پلاک 974",
      "میدان انقلاب، ابتدای کارگر جنوبی، نبش کوچه رشتچی",
      "میدان انقلاب، ابتدای کارگر جنوبی",
      "میدان انقلاب",
    ]);
    assert.ok(v.includes("میدان انقلاب، کارگر جنوبی"));
    assert.ok(v.length <= 6);
  });

  test("puts the city first when the address does not name it, and reads other separators", () => {
    const v = addressVariants("خیابان ولیعصر - نرسیده به ونک, واحد ۳", "تهران");
    assert.equal(v[0], "تهران، خیابان ولیعصر، نرسیده به ونک، واحد 3");
    assert.ok(v.includes("تهران، خیابان ولیعصر، نرسیده به ونک"));
    assert.deepEqual(addressVariants("تهران، ونک", "تهران")[0], "تهران، ونک");
    assert.deepEqual(addressVariants("  "), []);
    // never down to a bare name
    assert.equal(addressVariants("تهران، نامعلوم").includes("تهران"), false);
  });
});
