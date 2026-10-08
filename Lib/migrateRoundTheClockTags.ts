import mongoose from "mongoose";
import Clinic from "../Models/Clinic";
import ClinicTag from "../Models/ClinicTag";
import Hospital from "../Models/Hospital";
import HospitalTag from "../Models/HospitalTag";
import ParaClinic from "../Models/Paraclinic";
import ParaClinicTag from "../Models/ParaClinicTag";
import {
  hasWeeklyHours,
  isRoundTheClockText,
  OpeningHours,
  roundTheClockDays,
} from "./openingHours";
import { blockIfReferenced } from "./refIntegrity";

// The «شبانه‌روزی» tag (2026-10): a centre tag that only said "open round
// the clock" duplicated the structured opening hours (Lib/openingHours.ts),
// and the two could disagree (a 24h tag on a centre closed at night). For
// every clinic, hospital and lab carrying such a tag:
// - with no weekly hours yet, it becomes round the clock (every day
//   00:00-24:00, its holidays kept; the model's hook sets isRoundTheClock);
// - hours already set win (the tag is just dropped, logged);
// - the tag is pulled from it, and the tag record deleted once nothing
//   points at it.
// Pharmacies carry no tags. Idempotent: once the tags are gone there is
// nothing to match, and noRoundTheClockTagPlugin keeps new ones out, so it
// runs on every boot.

const targets: { centre: mongoose.Model<any>; tag: mongoose.Model<any> }[] = [
  { centre: Clinic, tag: ClinicTag },
  { centre: Hospital, tag: HospitalTag },
  { centre: ParaClinic, tag: ParaClinicTag },
];

export const migrateRoundTheClockTags = async () => {
  const log: string[] = [];
  for (const { centre, tag } of targets) {
    const tags = await tag.find({}).select("_id name").lean<{ _id: mongoose.Types.ObjectId; name?: string }[]>();
    const ids = tags.filter((t) => isRoundTheClockText(t.name)).map((t) => t._id);
    if (!ids.length) continue;
    const rows = await centre
      .find({ tags: { $in: ids } })
      .select("_id name openingHours")
      .lean<{ _id: mongoose.Types.ObjectId; name?: string; openingHours?: OpeningHours }[]>();
    let filled = 0;
    let kept = 0;
    for (const row of rows) {
      try {
        if (!hasWeeklyHours(row.openingHours)) {
          const had = row.openingHours as Partial<OpeningHours> | undefined;
          const exceptions = Array.isArray(had?.exceptions) ? had!.exceptions : [];
          // the model's hook normalises the week, derives weekIntervals and
          // sets isRoundTheClock
          await centre.updateOne({ _id: row._id }, { $set: { openingHours: { days: roundTheClockDays(), exceptions } } });
          filled += 1;
        } else {
          kept += 1;
          console.log(
            `[roundTheClockTags] ${centre.modelName} ${String(row._id)} (${row.name || ""}) has its own hours; only the tag is removed`,
          );
        }
        await centre.updateOne({ _id: row._id }, { $pull: { tags: { $in: ids } } });
      } catch (err) {
        console.log(`[roundTheClockTags] ${centre.modelName} ${String(row._id)}:`, err);
      }
    }
    let deleted = 0;
    for (const id of ids) {
      // still used somewhere (a centre that failed above): left in place
      const inUse = await blockIfReferenced(tag.modelName)(String(id));
      if (inUse) continue;
      await tag.deleteOne({ _id: id });
      deleted += 1;
    }
    log.push(
      `${centre.modelName}: ${rows.length} centre(s) untagged, ${filled} set round the clock, ${kept} kept their hours; ${deleted}/${ids.length} ${tag.modelName} deleted`,
    );
  }
  if (log.length) console.log(`[roundTheClockTags] ${log.join(" | ")}`);
};
