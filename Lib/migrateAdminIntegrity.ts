import mongoose from "mongoose";
import Service from "../Models/Service";
import ParaClinicTest from "../Models/ParaClinicTest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import Reservation from "../Models/Reservation";
import DoctorPatient from "../Models/DoctorPatient";

// One-off data repairs from the 2026-09 super-admin audit; each is
// idempotent, so running it on every boot is cheap and safe.
export const migrateAdminIntegrity = async () => {
  // the doctor's patient list was never filled (2026-10): every patient who
  // booked with a doctor becomes that doctor's patient
  const pairs = await Reservation.aggregate<{ _id: { user: unknown; doctor: unknown } }>([
    { $match: { user: { $ne: null }, doctor: { $ne: null } } },
    { $group: { _id: { user: "$user", doctor: "$doctor" } } },
  ]);
  if (pairs.length)
    await DoctorPatient.bulkWrite(
      pairs.map(({ _id }) => ({
        updateOne: {
          filter: { user: _id.user, doctor: _id.doctor },
          update: { $setOnInsert: { user: _id.user, doctor: _id.doctor } },
          upsert: true,
        },
      })) as any,
      { ordered: false },
    ).catch(() => undefined);

  // a service must belong to a provider: one without an owner could be paid
  // for and no doctor would ever receive the order
  await Service.updateMany(
    { $or: [{ owner: { $exists: false } }, { owner: null }], isActive: true },
    { $set: { isActive: false } },
  );

  // a lab offer whose test was deleted crashed the panels and kept selling
  const tests = mongoose.connection.collection("tests");
  const offers = await ParaClinicTest.find({}).select("test").lean<{ _id: unknown; test?: unknown }[]>();
  const ids = offers.map((o) => o.test).filter(Boolean) as mongoose.Types.ObjectId[];
  if (ids.length) {
    const alive = new Set(
      (await tests.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray()).map((t) => String(t._id)),
    );
    const dead = offers.filter((o) => !o.test || !alive.has(String(o.test))).map((o) => o._id);
    if (dead.length) await ParaClinicTest.deleteMany({ _id: { $in: dead } });
  }

  // "Done" could be set by hand with nothing created: back to the queue
  for (const model of [
    ClinicAdditionRequest,
    HospitalAdditionRequest,
    PharmacyAdditionRequest,
    InsuranceAdditionRequest,
  ] as mongoose.Model<any>[])
    await model.updateMany(
      { status: "Done", $or: [{ createdNode: { $exists: false } }, { createdNode: null }] },
      { $set: { status: "Pending" } },
    );

  // doctor SEO moved from the dead /doctor/[slug] route to the bookable
  // profile /dr/[slug] (2026-10); an entry already there for a slug wins
  const pageMetas = mongoose.connection.collection("pagemetas");
  const legacy = await pageMetas.find({ resourceType: "/doctor/[slug]" }).toArray();
  for (const doc of legacy) {
    const taken = await pageMetas.findOne({ resourceType: "/dr/[slug]", slug: doc.slug });
    if (taken) await pageMetas.deleteOne({ _id: doc._id });
    else await pageMetas.updateOne({ _id: doc._id }, { $set: { resourceType: "/dr/[slug]" } });
  }

  // the withdrawal minimum moved from AppConfig to the finance settings,
  // next to the settlement period (2026-10); an older install keeps its value
  const cfg = await mongoose.connection.collection("appconfigs").findOne({}, { projection: { withdrawalMinAmount: 1 } });
  await mongoose.connection
    .collection("globalfinancesettings")
    .updateOne(
      { withdrawalMinAmount: { $exists: false } },
      { $set: { withdrawalMinAmount: cfg?.withdrawalMinAmount || 10_000 } },
    );

  // reading time for posts written before it was computed (2026-10)
  const { default: Blog, readMinutesOf } = await import("../Models/Blog");
  const posts = await Blog.find({ readMinutes: { $exists: false } }).select("content").lean<{ _id: unknown; content?: string }[]>();
  for (const p of posts) {
    const minutes = readMinutesOf(p.content);
    if (minutes) await Blog.collection.updateOne({ _id: p._id as any }, { $set: { readMinutes: minutes } });
  }

  // the council code a doctor's inquiry verified is the profile's code
  // (2026-10): profiles that only had the McCode link get the text copy
  const linked = await mongoose.connection
    .collection("doctorprofiles")
    .find({ mcCode: { $ne: null }, $or: [{ medicalSystemCode: { $exists: false } }, { medicalSystemCode: "" }] })
    .project({ mcCode: 1 })
    .toArray();
  for (const d of linked) {
    const mc = await mongoose.connection.collection("mccodes").findOne({ _id: d.mcCode }, { projection: { mcCode: 1 } });
    if (mc?.mcCode)
      await mongoose.connection.collection("doctorprofiles").updateOne({ _id: d._id }, { $set: { medicalSystemCode: String(mc.mcCode) } });
  }

  // doctors' locations follow their offices (2026-10, Lib/doctorLocation.ts)
  const { syncDoctorLocation } = await import("./doctorLocation");
  const doctorIds = await mongoose.connection
    .collection("offices")
    .distinct("doctor", { "location.coordinates.1": { $exists: true } });
  for (const id of doctorIds) await syncDoctorLocation(id).catch(() => {});
};
