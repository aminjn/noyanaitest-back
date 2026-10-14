import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { externalFetchStubs, startTestApp, stopTestApp } from "./helpers";
import AppConfig from "../Models/AppConfig";
import Pharmacy from "../Models/Pharmacy";
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
});
