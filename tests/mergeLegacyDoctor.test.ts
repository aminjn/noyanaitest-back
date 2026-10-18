import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { startTestApp, stopTestApp } from "./helpers";
import Doctor from "../Models/Doctor";
import DoctorProfile from "../Models/DoctorProfile";
import { findSameDoctor, mergeLegacyDoctor } from "../Lib/mergeLegacyDoctors";

// Moving the old site onto the new one (2026-10): a doctor the new site
// already lists (from the partner import) is the same profile, not a second
// one - found by council number, phone + surname, or full name + speciality.

before(startTestApp);
after(stopTestApp);

const spec = new mongoose.Types.ObjectId();
const legacy = (fields: Record<string, unknown>) =>
  Doctor.collection.insertOne({ _id: new mongoose.Types.ObjectId(), active: true, ...fields }).then((r) => Doctor.collection.findOne({ _id: r.insertedId }));

describe("legacy doctor matching", () => {
  test("council number, phone with the surname, then name + speciality", async () => {
    const byCode = await DoctorProfile.create({ firstName: "زهرا", lastName: "فلاح", medicalSystemCode: "123456", landLine: "02177001122", claimed: false, introduction: "از شریک" });
    const byPhone = await DoctorProfile.create({ firstName: "مریم", lastName: "کریمی", landLine: "02177003344", claimed: false });
    const byName = await DoctorProfile.create({ firstName: "علی", lastName: "رضایی", mainSpeciality: spec, claimed: false });
    await DoctorProfile.create({ firstName: "حسن", lastName: "احمدی", mainSpeciality: spec, claimed: false });
    await DoctorProfile.create({ firstName: "حسن", lastName: "احمدی", mainSpeciality: spec, claimed: false });

    const a = await legacy({ name: "دکتر زهرا فلاح", code: "۱۲۳۴۵۶", description: "قدیمی" });
    assert.equal(String((await findSameDoctor(a))?._id), String(byCode._id));
    const b = await legacy({ name: "دکتر مریم كريمي", landLine: "+98 21 7700 3344" });
    assert.equal(String((await findSameDoctor(b))?._id), String(byPhone._id));
    const c = await legacy({ name: "علی رضایی", speciality: spec });
    assert.equal(String((await findSameDoctor(c))?._id), String(byName._id));
    // two candidates: no guess
    assert.equal(await findSameDoctor(await legacy({ name: "حسن احمدی", speciality: spec })), null);
    // a different council number is a different doctor
    assert.equal(await findSameDoctor(await legacy({ name: "زهرا فلاح", landLine: "02177001122", code: "999" })), null);

    // merged: the existing profile is linked, nothing new is created
    const before = await DoctorProfile.countDocuments();
    const p = await mergeLegacyDoctor(a);
    assert.equal(String(p._id), String(byCode._id));
    assert.equal(await DoctorProfile.countDocuments(), before);
    const linked: any = await DoctorProfile.findById(byCode._id).lean();
    assert.equal(String(linked.legacyDoctor), String(a!._id));
    assert.equal(linked.introduction, "از شریک");
    // a profile one legacy doctor holds is not matched to another
    assert.equal(await findSameDoctor(await legacy({ name: "زهرا فلاح", code: "123456" })), null);
  });
});
