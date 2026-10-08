import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import { ensureServiceCategory, serviceIdList } from "./serviceCatalog";

// A doctor's services come from the catalogue (owner decision 2026-10,
// doctor audit 3.2e). Each profile's old free-text `services` strings become
// ServiceCategory references: a string matches an existing entry by its
// normalised name (Lib/serviceCatalog.ts, ی/ي, ک/ك, spaces, half-spaces,
// case), a missing one is created under review, suggested by that doctor.
// Idempotent: it only touches profiles that still carry the old field, and
// removes it once converted (the schema no longer knows it).
export const migrateDoctorServices = async () => {
  const collection = DoctorProfile.collection;
  const cursor = collection.find(
    { services: { $exists: true } },
    { projection: { services: 1, serviceCategories: 1, translations: 1 } },
  );
  let profiles = 0;
  let created = 0;
  for await (const doc of cursor) {
    const raw: unknown[] = Array.isArray(doc.services) ? doc.services : [];
    const ids = serviceIdList(doc.serviceCategories);
    const have = new Set(ids.map(String));
    for (const entry of raw) {
      // a half-run conversion may have left ids in the old field
      const asId = serviceIdList([entry])[0];
      const result = asId
        ? { node: { _id: asId }, created: false }
        : await ensureServiceCategory(entry, doc._id);
      if (!result) continue;
      if (result.created) created++;
      const id = String(result.node._id);
      if (have.has(id)) continue;
      have.add(id);
      ids.push(new mongoose.Types.ObjectId(id));
    }
    // the old strings' translations go with them
    const unset: Record<string, 1> = { services: 1 };
    const translations = (doc as { translations?: Record<string, unknown> }).translations;
    if (translations && typeof translations === "object")
      for (const locale of Object.keys(translations))
        unset[`translations.${locale}.services`] = 1;
    await collection.updateOne(
      { _id: doc._id },
      { $set: { serviceCategories: ids }, $unset: unset },
    );
    profiles++;
  }
  if (profiles)
    console.log(
      `[doctorServices] ${profiles} profile(s) moved to the service catalogue, ${created} entr${created === 1 ? "y" : "ies"} created for review`,
    );
};
