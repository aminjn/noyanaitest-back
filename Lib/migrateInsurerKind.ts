import Insurance from "../Models/Insurance";
import { insurerKindOf } from "./insuranceTariffs";

// Insurance.isBasic (basic vs supplementary) arrived after the insurers
// were entered, so Tamin, Salamat and the armed forces' insurer were stored
// without it and read as supplementary: the booking then refused them
// together («فقط یک بیمه‌ی تکمیلی»), stacked them in the wrong order, and
// their claim lists said "tamin" while the quote's role said
// "supplementary". Once, and only where the admin never set the flag: an
// insurer named as one of the public basic insurers becomes basic. Saved
// through the model so a lab's «بیمه پایه» follows (Models/Insurance.ts).
export const migrateInsurerKind = async () => {
  const rows = await Insurance.collection
    .find({ isBasic: { $exists: false } }, { projection: { name: 1 } })
    .toArray();
  let n = 0;
  for (const row of rows) {
    const kind = insurerKindOf({ name: String(row.name || ""), isBasic: false });
    const basic = kind === "tamin" || kind === "salamat" || kind === "armed";
    await Insurance.findOneAndUpdate({ _id: row._id, isBasic: { $exists: false } }, { $set: { isBasic: basic } });
    if (basic) n += 1;
  }
  if (rows.length) console.log(`[insurance] isBasic set on ${rows.length} insurers (${n} basic)`);
};
