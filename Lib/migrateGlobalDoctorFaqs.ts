import DoctorFaq from "../Models/DoctorFaq";

// The questions an admin wrote "for every doctor" (DoctorFaq with no
// doctor) were shown on every doctor's page and in its FAQPage data - a
// mistake the automatic FAQ (Lib/autoFaq.ts, 2026-10) replaces. They are
// archived, not deleted: nothing is lost, nothing shows them. Idempotent.
export const migrateGlobalDoctorFaqs = async () => {
  const res = await DoctorFaq.collection.updateMany(
    { $or: [{ doctor: null }, { doctor: { $exists: false } }], archived: { $ne: true } },
    { $set: { archived: true } },
  );
  if (res.modifiedCount) console.log(`[doctorFaq] archived ${res.modifiedCount} questions shared by every doctor page`);
};
