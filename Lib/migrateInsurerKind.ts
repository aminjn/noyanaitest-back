import Insurance from "../Models/Insurance";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
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

// «شماره‌ی مجوز بیمه مرکزی» (2026-10): an insurer approved before the
// licence number existed had its request's siam code dropped on approval.
// Once per insurer with no licence number: its approved request's licence
// number, or the old siam code it gave, is copied over.
export const migrateInsurerLicense = async () => {
  const insurers = await Insurance.collection
    .find({ user: { $exists: true }, $or: [{ licenseNumber: { $exists: false } }, { licenseNumber: "" }] }, { projection: { user: 1 } })
    .toArray();
  if (!insurers.length) return;
  const requests = await BecomeInsuranceRequest.collection
    .find({ user: { $in: insurers.map((i) => i.user) }, status: "Approved" }, { projection: { user: 1, licenseNumber: 1, siamCode: 1 } })
    .toArray();
  const codeOf = new Map(
    requests.map((r) => [String(r.user), String(r.licenseNumber || r.siamCode || "").trim().slice(0, 60)]),
  );
  let n = 0;
  for (const i of insurers) {
    const code = codeOf.get(String(i.user));
    if (!code) continue;
    await Insurance.collection.updateOne(
      { _id: i._id, $or: [{ licenseNumber: { $exists: false } }, { licenseNumber: "" }] },
      { $set: { licenseNumber: code } },
    );
    n += 1;
  }
  if (n) console.log(`[insurance] licence number copied from the approved request on ${n} insurers`);
};
