import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { externalFetchStubs, startTestApp, stopTestApp } from "./helpers";
import AppConfig from "../Models/AppConfig";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import { clearNexaMapSettingsCache } from "../Lib/nexamap";
import { clearGeoCandidateCache, divisionsForPoint } from "../Lib/geoFromPoint";

// A pin fills its province and city from NexaMap (2026-10, the owner's
// rule for the provider import) even when our divisions were never synced:
// a division NexaMap names that we lack is added from its id and name.

const STUB = "https://nexamap.test";
let resolveCalls = 0;

before(async () => {
  await startTestApp();
  await AppConfig.updateOne(
    { singleton: "SINGLETON" },
    { $set: { nexamapEnabled: true, nexamapBaseUrl: STUB, nexamapApiKey: "stub-key" } },
    { upsert: true },
  );
  clearNexaMapSettingsCache();
  externalFetchStubs.push((url) => {
    if (!url.startsWith(`${STUB}/v1/divisions/resolve`)) return undefined;
    resolveCalls++;
    return new Response(
      JSON.stringify({
        status: "OK",
        data: {
          province: { id: "p-21", name: "یزد", name_en: "Yazd" },
          city: { id: "c-2101", name: "یزد", name_en: "Yazd" },
          district: null,
        },
        meta: {},
        warnings: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});
after(stopTestApp);

describe("divisionsForPoint", () => {
  test("adds the province and city NexaMap names when we have no record", async () => {
    clearGeoCandidateCache();
    assert.equal(await Province.countDocuments({ nexamapId: "p-21" }), 0);
    const ids = await divisionsForPoint({ lat: 31.8832, lng: 54.3569 });
    assert.ok(ids.province, "province filled");
    assert.ok(ids.city, "city filled");
    const p = await Province.findById(ids.province).lean<any>();
    const c = await City.findById(ids.city).lean<any>();
    assert.equal(p.name, "یزد");
    assert.equal(p.nexamapId, "p-21");
    assert.equal(c.nexamapId, "c-2101");
    assert.equal(String(c.province), String(ids.province));
    assert.equal(c.translations?.en?.name, "Yazd");
  });

  test("a second pin in the same city reuses the records", async () => {
    clearGeoCandidateCache();
    const first = await divisionsForPoint({ lat: 31.89, lng: 54.36 });
    const again = await divisionsForPoint({ lat: 31.9, lng: 54.37 });
    assert.equal(String(first.city), String(again.city));
    assert.equal(await Province.countDocuments({ nexamapId: "p-21" }), 1);
    assert.equal(await City.countDocuments({ nexamapId: "c-2101" }), 1);
    assert.ok(resolveCalls >= 2);
  });
});
