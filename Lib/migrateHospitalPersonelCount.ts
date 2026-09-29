import Hospital from "../Models/Hospital";

// Hospital.personelCount was a String (the forms and the other centres use a
// number). Stored strings are converted once - a number where it parses,
// removed where it does not - before the schema reads it as a Number.
export const migrateHospitalPersonelCount = async () => {
  const rows = await Hospital.collection
    .find({ personelCount: { $type: "string" } }, { projection: { personelCount: 1 } })
    .toArray();
  for (const row of rows) {
    const raw = String(row.personelCount)
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[^\d]/g, "");
    const n = raw ? Number(raw) : NaN;
    await Hospital.collection.updateOne(
      { _id: row._id },
      Number.isFinite(n)
        ? { $set: { personelCount: n } }
        : { $unset: { personelCount: "" } },
    );
  }
  if (rows.length) console.log(`[hospital] personelCount converted on ${rows.length} rows`);
};
