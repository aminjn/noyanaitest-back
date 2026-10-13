import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { api, createDoctor, startTestApp, stopTestApp } from "./helpers";
import Speciality from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";
import CatalogSuggestion from "../Models/CatalogSuggestion";
import { duplicateGroups, mergeEntries, resolveSuggestion, suggestName, undoMerge, loadMatcher, seedCanonicalSpecialities } from "../Services/catalogCleanup";
import { CANONICAL_SPECIALITIES } from "../Lib/catalog/specialityCanonical";
import { matchName } from "../Lib/catalog/catalogMatch";

// The catalogue clean-up (2026-10): the variants a partner import created
// fold into one entry - doctors move, the old page redirects, the names
// become synonyms the next import matches - and a merge can be undone.

before(startTestApp);
after(stopTestApp);

describe("catalogue clean-up", () => {
  test("variants group, merge into the canonical entry, redirect and undo", async () => {
    const main = await Speciality.create({ name: "قلب و عروق", slug: "cardio-clean", active: true, canonical: true });
    const dupA = await Speciality.create({ name: "متخصص قلب و عروق", slug: "cardio-a", active: true });
    const dupB = await Speciality.create({ name: "قلب‌و‌عروق", slug: "cardio-b", active: true });
    const { doctor } = await createDoctor();
    await DoctorProfile.updateOne({ _id: doctor._id }, { $set: { mainSpeciality: dupA._id, specialities: [dupA._id, dupB._id] } });

    const groups = await duplicateGroups("speciality");
    const g = groups.find((x) => x.target.id === String(main._id));
    assert.ok(g, "a group for the canonical entry");
    assert.deepEqual(g!.members.map((m) => m.row.id).sort(), [String(dupA._id), String(dupB._id)].sort());

    const r = await mergeEntries("speciality", String(main._id), [String(dupA._id), String(dupB._id)]);
    assert.equal(r.merged, 2);
    const d = await DoctorProfile.findById(doctor._id).lean<any>();
    assert.equal(String(d.mainSpeciality), String(main._id));
    assert.deepEqual(d.specialities.map(String), [String(main._id)]);
    const a = await Speciality.findById(dupA._id).lean<any>();
    assert.equal(a.archived, true);
    assert.equal(a.active, false);
    assert.equal(String(a.mergedInto), String(main._id));

    // the old address leads to the target
    const page = await api("GET", "/api/v1/public/speciality/cardio-a");
    assert.equal(page.status, 200);
    assert.equal(page.body.data.redirect, "cardio-clean");

    // the merged name now matches the target
    const matcher = await loadMatcher("speciality");
    assert.equal(matchName(matcher, "متخصص قلب و عروق").status !== "none" && matchName(matcher, "متخصص قلب و عروق").row?.id, String(main._id));

    await undoMerge(String(r.merge));
    const back = await DoctorProfile.findById(doctor._id).lean<any>();
    assert.equal(String(back.mainSpeciality), String(dupA._id));
    assert.ok(back.specialities.map(String).includes(String(dupA._id)));
    const restored = await Speciality.findById(dupA._id).lean<any>();
    assert.equal(restored.archived, false);
    assert.equal(restored.active, true);
  });

  test("a name nobody knows waits in the queue; mapping it gives the doctors the entry", async () => {
    const target = await Speciality.create({ name: "پوست و مو", slug: "derm-clean", active: true, canonical: true });
    const { doctor } = await createDoctor();
    await suggestName("speciality", "زیبایی پوست تخصصی لیزر", { doctor: doctor._id as any, draft: true });
    const s = await CatalogSuggestion.findOne({ kind: "speciality", raw: "زیبایی پوست تخصصی لیزر" });
    assert.ok(s);
    assert.equal(s!.doctorCount, 1);
    await resolveSuggestion(String(s!._id), "map", String(target._id));
    const d = await DoctorProfile.findById(doctor._id).lean<any>();
    assert.ok(d.specialities.map(String).includes(String(target._id)));
    const t = await Speciality.findById(target._id).lean<any>();
    assert.ok(t.synonyms.includes("زیبایی پوست تخصصی لیزر"));
  });

  test("the official list takes over an existing entry and runs twice without changes", async () => {
    const old = await Speciality.create({ name: "متخصص زنان و زایمان", slug: "gyn-old", active: true });
    const first = await seedCanonicalSpecialities();
    assert.equal(first.total, CANONICAL_SPECIALITIES.length);
    const kept = await Speciality.findById(old._id).lean<any>();
    assert.equal(kept.canonical, true, "the existing entry became the canonical one");
    assert.equal(kept.slug, "gyn-old", "its address stays");
    const count = await Speciality.countDocuments({ canonical: true });
    const again = await seedCanonicalSpecialities();
    assert.equal(again.created, 0);
    assert.equal(await Speciality.countDocuments({ canonical: true }), count);
  });
});
