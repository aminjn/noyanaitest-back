import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { externalFetchStubs, startTestApp, stopTestApp } from "./helpers";
import AppConfig from "../Models/AppConfig";
import Pharmacy from "../Models/Pharmacy";
import Province from "../Models/Geo/Province";
import { clearGeoCandidateCache } from "../Lib/geoFromPoint";
import { clearNexaMapSettingsCache } from "../Lib/nexamap";
import { runImport } from "../Services/providerImport";
import { BUILTIN_TEMPLATES } from "../Lib/providerImport/partners";

// The DrDr pharmacies file has no real pins (2026-10): each pharmacy's pin
// comes from its address through NexaMap's geocoder - the v1 answer
// («ok: true», results[].location, match_level, confidence). A match no
// finer than the city is not used (it would be Tehran's centre again).

const STUB = "https://nexamap.test";
const geocoded: string[] = [];

before(async () => {
  await startTestApp();
  await AppConfig.updateOne(
    { singleton: "SINGLETON" },
    { $set: { nexamapEnabled: true, nexamapBaseUrl: STUB, nexamapApiKey: "stub-key" } },
    { upsert: true },
  );
  clearNexaMapSettingsCache();
  await Province.create({ name: "تهران", nexamapId: "p-tehran" } as any);
  await Province.create({ name: "یزد", nexamapId: "p-yazd" } as any);
  clearGeoCandidateCache();
  const ABARKUH = { lat: 31.1304, lng: 53.2829 };
  const SAADAT = { lat: 35.7796, lng: 51.3712 };
  externalFetchStubs.push((url) => {
    if (!url.startsWith(`${STUB}/v1/divisions/resolve`)) return undefined;
    const lat = Number(new URL(url).searchParams.get("lat"));
    const province = lat < 33 ? { id: "p-yazd", name: "یزد" } : { id: "p-tehran", name: "تهران" };
    return new Response(JSON.stringify({ ok: true, data: { province, city: null, district: null } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  externalFetchStubs.push((url) => {
    if (!url.startsWith(`${STUB}/v1/geocode`) || !(new URL(url).searchParams.get("address") || "").includes("سرو")) return undefined;
    geocoded.push("سرو");
    // the wrong town first (Abarkuh's «سرو»), the right square second
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          results: [
            { formatted_address: "میدان سرو، ابرکوه", location: ABARKUH, match_level: "street", confidence: 0.9 },
            { formatted_address: "میدان سرو، سعادت‌آباد، تهران", location: SAADAT, match_level: "street", confidence: 0.8 },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  externalFetchStubs.push((url) => {
    if (!url.startsWith(`${STUB}/v1/geocode`)) return undefined;
    const address = new URL(url).searchParams.get("address") || "";
    geocoded.push(address);
    const coarse = address.includes("نامعلوم");
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          results: [
            coarse
              ? { formatted_address: "تهران", location: { lat: 35.6892, lng: 51.389 }, match_type: "city", match_level: "city", confidence: 0.9 }
              : { place_id: "pl_1", formatted_address: "خیابان ونک، تهران", location: { lat: 35.7557, lng: 51.4105 }, match_type: "street", match_level: "street", confidence: 0.87 },
          ],
          query_interpretation: { parsed_as: "structured_address", corrections: [] },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});
after(stopTestApp);

const rec = (name: string, address: string) => ({
  "نام": name,
  "نوع مرکز": "مرکز خصوصی",
  "تلفن": `0218${Math.floor(1000000 + Math.random() * 8999999)}`,
  "بیمه ها": null,
  "پزشکان دارو خانه": null,
  "لوکیشن": "35.71634907,51.3908792",
  "آدرس": address,
  "عکس": "https://example.com/default-place-avatar.jpg",
  "لینک پروفایل": "https://example.com/center/x",
});

describe("pharmacies import: pins from addresses", () => {
  test("a street-level match is the pin, a city-level one is not; a dry run calls nothing", async () => {
    const ph = BUILTIN_TEMPLATES.find((t) => t.key === "drdr-pharmacy")!;
    const root = { groups: [{ items: [rec("داروخانه ونک آزمون", "تهران، میدان ونک، خیابان ونک"), rec("داروخانه نامعلوم آزمون", "تهران، نامعلوم")] }] };

    await runImport(root, ph.mapping, "validate");
    assert.equal(geocoded.length, 0, "the dry run does not geocode");

    const report = await runImport(root, ph.mapping, "apply");
    assert.equal(report.totals.fail, 0);
    assert.equal(geocoded.length, 2);
    const vanak = await Pharmacy.findOne({ name: "داروخانه ونک آزمون" }).lean<any>();
    assert.deepEqual(vanak.location?.coordinates, [51.4105, 35.7557], "the street match is the pin, not the file's placeholder");
    const unknown = await Pharmacy.findOne({ name: "داروخانه نامعلوم آزمون" }).lean<any>();
    assert.ok(!unknown.location?.coordinates?.length, "a city-level match leaves no pin");
    const warned = report.records.some((r: any) => (r.issues || []).some((i: any) => i.field === "address"));
    assert.ok(warned, "the unplaced one is reported");
  });

  test("a match in another province than the record's is not the pin; a wrong pin from an earlier run is fixed", async () => {
    const ph = BUILTIN_TEMPLATES.find((t) => t.key === "drdr-pharmacy")!;
    const record = rec("داروخانه سرو آزمون", "تهران، سعادت آباد، میدان سرو، خیابان پاک نژاد");
    const root = { groups: [{ items: [record] }] };
    await runImport(root, ph.mapping, "apply");
    const doc = await Pharmacy.findOne({ name: "داروخانه سرو آزمون" }).lean<any>();
    assert.deepEqual(doc.location?.coordinates, [51.3712, 35.7796], "the Tehran candidate, not Abarkuh");

    // the pin's province is filled after the save (geoFromPoint): wait for it
    for (let i = 0; i < 50 && !(await Pharmacy.findById(doc._id).lean<any>())?.province; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    // an earlier run's wrong pin (in Yazd): applying the file again moves it
    const yazd = await Province.findOne({ name: "یزد" }).lean<any>();
    await Pharmacy.collection.updateOne({ _id: doc._id }, { $set: { location: { type: "Point", coordinates: [53.2829, 31.1304] }, province: yazd._id } });
    await runImport(root, ph.mapping, "apply");
    const fixed = await Pharmacy.findById(doc._id).lean<any>();
    assert.deepEqual(fixed.location?.coordinates, [51.3712, 35.7796], "re-applying fixes the wrong pin");
  });
});
