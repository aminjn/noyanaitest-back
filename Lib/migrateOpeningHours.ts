import mongoose from "mongoose";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";
import { parseLegacyHours, roundTheClockDays } from "./openingHours";

// One-off (2026-10, structured opening hours, Lib/openingHours.ts): a
// centre without a structured week gets one from what it had -
// - round the clock (isRoundTheClock): every day 00:00-24:00;
// - a simple free text ("۸ تا ۲۲", "8-22", "شبانه روزی", "8-13 و 16-21"):
//   that range every day;
// - anything else stays without a week (no badge) for the centre to set.
// The free text itself is never touched: it stays on the page as a note.
// Only centres with no openingHours are read, and a marker in `migrations`
// skips the whole run once done: safe to re-run.
const MARKER = "openingHours-2026-10";

const targets: { model: mongoose.Model<any>; text: string }[] = [
  { model: Pharmacy, text: "businessTime" },
  { model: ParaClinic, text: "businessTime" },
  { model: Clinic, text: "businessTimes" },
  { model: Hospital, text: "businessTimes" },
];

export const migrateOpeningHours = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const markers = db.collection<{ _id: string; at: Date }>("migrations");
  if (await markers.findOne({ _id: MARKER })) return;
  const counts: string[] = [];
  for (const { model, text } of targets) {
    const rows = await model
      .find({ openingHours: { $exists: false } })
      .select(`_id isRoundTheClock ${text}`)
      .lean<{ _id: unknown; isRoundTheClock?: boolean; [k: string]: unknown }[]>();
    let parsed = 0;
    for (const row of rows) {
      const legacy = row.isRoundTheClock ? { days: roundTheClockDays() } : parseLegacyHours(row[text]);
      if (!legacy) continue;
      // the model's hook derives weekIntervals and isRoundTheClock
      await model
        .updateOne({ _id: row._id, openingHours: { $exists: false } }, { $set: { openingHours: { days: legacy.days, exceptions: [] } } })
        .catch((err: unknown) => console.log(`[openingHours] ${model.modelName} ${String(row._id)}:`, err));
      parsed += 1;
    }
    counts.push(`${model.modelName} ${parsed}/${rows.length}`);
  }
  await markers.updateOne({ _id: MARKER }, { $set: { at: new Date() } }, { upsert: true });
  console.log(`[openingHours] structured hours migrated: ${counts.join(", ")}`);
};
