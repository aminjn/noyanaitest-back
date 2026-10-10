import DoctorProfile from "../Models/DoctorProfile";
import { syncDoctorPublished } from "./doctorPublish";

// One-time repair (2026-10): a doctor profile with an owner (a panel
// account) that still says claimed: false - a directory page linked to an
// account by a path that set only the owner. Such a doctor set hours and
// prices in the panel while the public page said "this doctor has no
// account" and offered no booking. The owner makes it claimed; the
// publish rule then decides whether it is live (Lib/doctorPublish.ts).
export const migrateOwnedDoctorsClaimed = async () => {
  const rows = await DoctorProfile.collection
    .find({ user: { $exists: true, $ne: null }, claimed: false }, { projection: { _id: 1, active: 1 } })
    .toArray();
  if (!rows.length) return 0;
  await DoctorProfile.collection.updateMany(
    { _id: { $in: rows.map((r) => r._id) } },
    // a page that was not public publishes itself once bookable
    { $set: { claimed: true } },
  );
  await DoctorProfile.collection.updateMany(
    { _id: { $in: rows.filter((r) => !r.active).map((r) => r._id) }, status: { $ne: "suspended" } },
    { $set: { autoPublish: true } },
  );
  for (const r of rows) await syncDoctorPublished(r._id).catch(() => {});
  console.log(`[doctors] ${rows.length} owned profile(s) marked claimed`);
  return rows.length;
};

// Every start (2026-10): a draft that waits for the automatic publish is
// checked again, so a rule that got looser (the photo is no longer
// required) publishes the doctors it was holding back without them having
// to touch the panel. Cheap: drafts are few.
export const republishReadyDrafts = async () => {
  const drafts = await DoctorProfile.collection
    .find({ active: { $ne: true }, autoPublish: true, status: { $ne: "suspended" } }, { projection: { _id: 1 } })
    .toArray();
  for (const d of drafts) await syncDoctorPublished(d._id).catch(() => {});
  return drafts.length;
};
