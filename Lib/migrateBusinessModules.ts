import mongoose from "mongoose";

// Boot migration (2026-10): Noyan Business adds the "accounting" module to
// every profile type's plan list (docs/business-suite.md: the books are part
// of every plan by default). Plans and the module snapshots of licenses
// already bought get it once; after that the super admin decides per plan,
// so a later removal is never undone. The marker makes it run one time.
const MARKER = "business-accounting-module";

export const migrateBusinessModules = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; at: Date }>("bootmigrations");
  if (await marks.findOne({ _id: MARKER })) return;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  const targets = names.filter((n) => /^(base.*licenses|.*profilelicenses)$/.test(n));
  let changed = 0;
  for (const name of targets) {
    const res = await db
      .collection(name)
      .updateMany({ modules: { $exists: true, $ne: "accounting" } }, { $addToSet: { modules: "accounting" } });
    changed += res.modifiedCount;
  }
  await marks.insertOne({ _id: MARKER, at: new Date() });
  console.log(`[business] accounting module added to ${changed} plans and licenses`);
};
