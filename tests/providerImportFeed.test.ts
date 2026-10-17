import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { externalFetchStubs, startTestApp, stopTestApp } from "./helpers";
import DoctorProfile from "../Models/DoctorProfile";
import ProviderImport from "../Models/ProviderImport";
import ProviderImportFeed from "../Models/ProviderImportFeed";
import { checkFeedUrl, maskFeedUrl, syncFeed } from "../Services/providerImportFeed";

// A contracted partner's live feed (2026-10): read page by page with
// limit / offset / next_offset, only what changed `since` the last finished
// run, run through the partner's template like an uploaded file - and the
// key never shown back.

const FEED = "https://93.184.216.34/feed/sections/7?key=Secret-Key-1234567890";
const asked: URL[] = [];

const record = (name: string, phone: string) => ({
  "نام": `دکتر ${name}`,
  "تخصص": "تخصص زنان و زایمان",
  "تلفن": phone,
  "معرفی پزشک": "معرفی",
  "بیماری ها": "",
  "خدمات": "",
  "لوکیشن": "",
  "آدرس": "تهران، خیابان ولیعصر",
  "عکس": "",
  "لینک پروفایل": "https://partner.example/dr/1",
});

before(async () => {
  await startTestApp();
  externalFetchStubs.push((url) => {
    if (!url.startsWith("https://93.184.216.34/feed/")) return undefined;
    const u = new URL(url);
    asked.push(u);
    const offset = Number(u.searchParams.get("offset"));
    const body =
      offset === 0
        ? { section: "زنان", groups: [{ items: [record("زهرا فلاح", "02177001122")] }], next_offset: 1 }
        : { section: "زنان", groups: [{ items: [record("مریم کریمی", "02177003344")] }], next_offset: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
after(stopTestApp);

const settle = async (id: string) => {
  for (let i = 0; i < 120; i++) {
    const feed = await ProviderImportFeed.findById(id).lean();
    if (feed && !feed.syncing && feed.lastRun?.status) return feed;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("feed run did not finish");
};

describe("provider import feed", () => {
  test("masks the key and refuses an address inside the network", async () => {
    const masked = maskFeedUrl(FEED);
    assert.equal(masked.includes("Secret-Key-1234567890"), false);
    assert.equal(masked.includes("7890"), true);
    for (const bad of ["http://127.0.0.1/feed", "http://localhost:5100/x", "http://10.0.0.2/x", "ftp://93.184.216.34/x", "nonsense"])
      await assert.rejects(checkFeedUrl(bad), bad);
  });

  test("reads every page, imports the records, then asks only for changes", async () => {
    const feed = await ProviderImportFeed.create({ name: "دکتر دکتر - زنان", url: FEED, intervalHours: 24 });
    await syncFeed(String(feed._id));
    const done = await settle(String(feed._id));
    assert.equal(done.lastRun?.status, "done", done.lastRun?.error);
    assert.equal(done.lastRun?.records, 2);
    assert.ok(done.syncedUntil);
    // page 1 then page 2 (next_offset), the key kept, no `since` the first time
    assert.deepEqual(asked.map((u) => u.searchParams.get("offset")), ["0", "1"]);
    assert.ok(asked.every((u) => u.searchParams.get("key") === "Secret-Key-1234567890" && u.searchParams.get("limit") === "500"));
    assert.equal(asked[0].searchParams.get("since"), null);
    const row = await ProviderImport.findById(done.lastRun?.importId).lean();
    assert.equal(row?.status, "done");
    assert.equal(await DoctorProfile.countDocuments({ lastName: { $in: ["فلاح", "کریمی"] } }), 2);

    // the next run: only what changed since the last one; the same doctors
    // update, none is created twice
    asked.length = 0;
    await syncFeed(String(feed._id));
    const again = await settle(String(feed._id));
    assert.equal(again.lastRun?.status, "done", again.lastRun?.error);
    const since = asked[0].searchParams.get("since");
    assert.match(since || "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(await DoctorProfile.countDocuments({ lastName: { $in: ["فلاح", "کریمی"] } }), 2);
  });
});
