import DoctorProfile from "../Models/DoctorProfile";

// DoctorProfile.slug had no unique index, so two doctors could share one
// /dr/<slug> URL (the page shows whichever the database returns first).
// Before the unique index is built: empty slugs are removed (the slug job
// fills them) and every duplicate after the first gets a "-2", "-3"... suffix.
export const dedupeDoctorSlugs = async () => {
  await DoctorProfile.updateMany({ slug: "" }, { $unset: { slug: 1 } });
  const dups = await DoctorProfile.aggregate<{ _id: string; ids: unknown[] }>([
    { $match: { slug: { $type: "string" } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: "$slug", ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const dup of dups) {
    let suffix = 2;
    for (const id of dup.ids.slice(1)) {
      let candidate = `${dup._id}-${suffix++}`;
      while (await DoctorProfile.exists({ slug: candidate }))
        candidate = `${dup._id}-${suffix++}`;
      await DoctorProfile.updateOne({ _id: id }, { $set: { slug: candidate } });
    }
  }
  if (dups.length)
    console.log(`[doctorSlugs] renamed duplicates of ${dups.length} slug(s)`);
  await DoctorProfile.createIndexes();
};
