import DoctorPatient from "../Models/DoctorPatient";

// Whoever books with a doctor is that doctor's patient (the panel's patient
// list and file). Idempotent; never fails the booking that calls it.
export const ensureDoctorPatient = async (user: unknown, doctor: unknown) => {
  if (!user || !doctor) return;
  await DoctorPatient.updateOne(
    { user, doctor },
    { $setOnInsert: { user, doctor } },
    { upsert: true },
  ).catch(() => undefined);
};
