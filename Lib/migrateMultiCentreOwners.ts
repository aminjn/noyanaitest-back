import { Model } from "mongoose";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";

// One account can own several clinics and hospitals (2026-10, the Doctolib /
// Practo multi-site pattern; Lib/activeCentre.ts). Clinic.user,
// Hospital.user and the two become-requests' user were unique, so a second
// centre or a second request hit a duplicate-key error. This drops a unique
// index on { user: 1 } where one exists and puts a plain one in its place.
// Safe to run on every start: a missing collection or an index that is
// already plain changes nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relaxUserIndex = async (model: Model<any>) => {
  const collection = model.collection;
  let indexes: { name?: string; key?: Record<string, unknown>; unique?: boolean }[];
  try {
    indexes = (await collection.indexes()) as typeof indexes;
  } catch {
    // the collection does not exist yet: nothing to drop
    return false;
  }
  let changed = false;
  for (const index of indexes) {
    const keys = Object.keys(index.key || {});
    if (index.unique && keys.length === 1 && keys[0] === "user" && index.name) {
      await collection.dropIndex(index.name);
      changed = true;
    }
  }
  if (changed) await collection.createIndex({ user: 1 });
  return changed;
};

export const migrateMultiCentreOwners = async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const model of [Clinic, Hospital, BecomeClinicRequest, BecomeHospitalRequest] as Model<any>[]) {
    if (await relaxUserIndex(model))
      console.log(`[multiCentre] ${model.collection.collectionName}: unique owner index dropped`);
  }
};
