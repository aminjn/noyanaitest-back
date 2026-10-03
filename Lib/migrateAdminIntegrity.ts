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
};
