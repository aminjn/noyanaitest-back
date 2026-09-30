import mongoose from "mongoose";
import Service from "../Models/Service";
import ParaClinicTest from "../Models/ParaClinicTest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";

// One-off data repairs from the 2026-09 super-admin audit; each is
// idempotent, so running it on every boot is cheap and safe.
export const migrateAdminIntegrity = async () => {
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
};
