import mongoose from "mongoose";

// Boot migration (2026-09): a plan's price options used to point at a
// separate LicenseDuration catalog ({ duration: <id>, price, ... }) that had
// to be filled in first. The period now lives on the option itself
// ({ days, price, ... }, Models/BaseLicensePricing.ts). This copies each
// referenced catalog entry's length onto the options once; plans already in
// the new shape are skipped, so it is safe to run on every boot.
export const migrateLicensePricing = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const names = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (el) => el.name,
    ),
  );
  if (!names.has("licensedurations")) return;
  const durations = new Map(
    (await db.collection("licensedurations").find({}).toArray()).map((el) => [
      String(el._id),
      Number(el.duration) || 0,
    ]),
  );
  const planCollections = [...names].filter((el) =>
    /^base.*licenses$/.test(el),
  );
  let migrated = 0;
  for (const name of planCollections) {
    const plans = db.collection(name);
    const cursor = plans.find({ "pricing.duration": { $exists: true } });
    for await (const plan of cursor) {
      const byDays = new Map<
        number,
        { days: number; isActive: boolean; price: number; discount: number }
      >();
      for (const row of (plan.pricing || []) as Record<string, unknown>[]) {
        const days =
          typeof row.days === "number"
            ? row.days
            : durations.get(String(row.duration)) || 0;
        if (!(days > 0)) continue;
        const next = {
          days,
          isActive: !!row.isActive,
          price: Number(row.price) || 0,
          discount: Number(row.discount) || 0,
        };
        // two catalog entries of the same length: keep the active one
        const prev = byDays.get(days);
        if (!prev || (!prev.isActive && next.isActive)) byDays.set(days, next);
      }
      await plans.updateOne(
        { _id: plan._id },
        {
          $set: {
            pricing: [...byDays.values()].sort((a, b) => a.days - b.days),
          },
        },
      );
      migrated++;
    }
  }
  if (migrated) console.log(`[licenses] moved periods into ${migrated} plans`);
};
