import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_TEMPLATES, detectBuiltinTemplate } from "../Lib/providerImport/partners";
import { mapRecord, mappingSchema } from "../Lib/providerImport/mapping";
import { buildCatalogIndex, learnJoinedNames, splitLearnt } from "../Lib/providerImport/textExtract";

// The DrDr partner template (2026-10, the owner's rule): each field goes
// straight to one place on the doctor's profile, nothing is mined out of the
// introduction, the profile link and the file's metadata are not kept, and a
// doctor is keyed by name + phone.

const record = (over: Record<string, unknown> = {}) => ({
  "نام": "دکتر زهرا فلاح",
  "تخصص": "تخصص زنان و زایمان",
  "تلفن": "03537332728",
  "معرفی پزشک": "درباره دکتر زهرا فلاح کد نظام پزشکی 137448. نوبت از سایت دکتر دکتر.",
  "بیماری ها": "زگیل تناسلی زنان خونریزی رحم",
  "خدمات": "سزارین پاپ اسمیر",
  "لوکیشن": "31.883197372471,54.356863181067",
  "آدرس": "یزد-بلوار طالقانی، کوچه هدایتی",
  "عکس": "https://drdr.ir/_next/image/?url=https%3A%2F%2Fcdn.drdr.ir%2Fstorage%2Fa.jpg&w=96&q=75",
  "لینک پروفایل": "https://drdr.ir/dr/71461/%D8%AF%DA%A9%D8%AA%D8%B1",
  ...over,
});
const file = (items: unknown[]) => ({ site: "x", section: "y", contract_ref: "c1", generated_at: "2026-10-12", groups: [{ source: "s", items }] });
const drdr = BUILTIN_TEMPLATES.find((t) => t.key === "drdr")!;
const list = drdr.mapping.lists[0];

describe("DrDr partner template", () => {
  test("ships a valid mapping with exactly the fixed fields", () => {
    assert.equal(mappingSchema.safeParse(drdr.mapping).success, true);
    assert.deepEqual(
      drdr.fields.map((f) => f.source),
      ["نام", "تخصص", "تلفن", "معرفی پزشک", "بیماری ها", "خدمات", "لوکیشن", "آدرس", "عکس", "لینک پروفایل"],
    );
    assert.equal(drdr.fields.find((f) => f.source === "لینک پروفایل")?.to, "ignored");
    // nothing of the template reads the profile link or the file's metadata
    const text = JSON.stringify(drdr.mapping);
    for (const banned of ["لینک پروفایل", "$root", "$parent", "contract_ref", "generated_at"]) assert.equal(text.includes(banned), false, banned);
  });

  test("is recognised by the records' fields, not by the file's metadata", () => {
    assert.equal(detectBuiltinTemplate(file([record(), record()])), "drdr");
    assert.equal(detectBuiltinTemplate({ ...file([record()]), site: "other" }), "drdr");
    assert.equal(detectBuiltinTemplate({ groups: [{ items: [{ name: "a", phone: "1" }] }] }), undefined);
    assert.equal(detectBuiltinTemplate([record()]), undefined);
  });

  test("maps each field straight to its place", () => {
    const out = mapRecord(record(), list, drdr.mapping.options);
    assert.equal(out.firstName, "زهرا");
    assert.equal(out.lastName, "فلاح");
    assert.equal(out.mainSpeciality, "تخصص زنان و زایمان");
    // the introduction as written: no cleanup, no council number taken out
    assert.equal(out.bio, record()["معرفی پزشک"]);
    assert.equal(out.medicalCode, undefined);
    assert.equal(out.phone, "983537332728");
    assert.equal(out.photo, "https://cdn.drdr.ir/storage/a.jpg");
    assert.equal(out.address, "یزد-بلوار طالقانی، کوچه هدایتی");
    // the profile link goes nowhere
    assert.equal(JSON.stringify(out).includes("drdr.ir/dr/"), false);
    assert.match(String(out.externalId), /^drdr:[0-9a-f]{16}$/);
  });

  test("keys a doctor by name and phone, blind to the title, spacing and phone format", () => {
    const id = (over: Record<string, unknown>) => mapRecord(record(over), list).externalId;
    const base = id({});
    assert.equal(id({ "نام": "زهرا  فلاح", "تلفن": "+98 35 3733 2728" }), base);
    assert.equal(id({ "لینک پروفایل": "https://drdr.ir/dr/99999/x" }), base);
    assert.notEqual(id({ "تلفن": "03537332729" }), base);
    assert.notEqual(id({ "نام": "دکتر زهرا فلاحی" }), base);
    // no phone: the name alone
    assert.match(String(id({ "تلفن": null })), /^drdr:[0-9a-f]{16}$/);
  });
});

describe("names joined with no separator", () => {
  // four names, each listed in another order by eight doctors
  const A = "زگیل تناسلی زنان";
  const B = "خونریزی رحم";
  const C = "کیست تخمدان";
  const D = "یائسگی";
  const orders = [[A, B, C], [C, A, D], [B, D, C], [D, B, A], [A, C, B], [C, D, A], [B, A, C], [D, C, B]];
  const lists = orders.map((o) => o.join(" "));

  test("the names the file repeats in different orders come apart", () => {
    const m = learnJoinedNames(lists);
    orders.forEach((o, i) => assert.deepEqual(splitLearnt(lists[i], m), o));
  });

  test("the same file splits the same way once the names are in the catalogue", () => {
    const m = learnJoinedNames(lists);
    const first = lists.map((l) => splitLearnt(l, m));
    const names = [...new Set(first.flat())];
    const catalogue = buildCatalogIndex(names.map((name, i) => ({ id: String(i), name })));
    assert.deepEqual(lists.map((l) => splitLearnt(l, m, catalogue)), first);
  });
});
