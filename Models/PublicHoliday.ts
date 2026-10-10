import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { translatable } from "../Lib/i18n/translatable";

// Iran's official holidays (2026-10, Lib/publicHolidays.ts): one Tehran day
// each. The fixed solar days and the lunar days of the official calendar
// (University of Tehran Geophysics Institute) are seeded at boot
// (Lib/publicHolidaySeed.ts, `seedKey`); the super admin adds the next
// year's lunar days once the calendar is published, edits or switches one
// off (never deleted, so a seed never comes back). A doctor is closed on an
// active one unless they choose to work (Models/DoctorHolidayPolicy.ts).
export const publicHolidayKinds = ["solar", "lunar", "custom"] as const;
export type PublicHolidayKind = (typeof publicHolidayKinds)[number];

export interface IPublicHoliday extends MongoDoc {
  // the Tehran day, "YYYY-MM-DD"
  ymd: string;
  // Persian (SOURCE_LOCALE); other languages in `translations`
  title: string;
  kind: PublicHolidayKind;
  active: boolean;
  // the seed row it came from (absent for one the admin added)
  seedKey?: string;
  // worked out, not from the official calendar (Lib/lunarHolidays.ts);
  // an admin edit of the day makes it official
  estimated?: boolean;
  createdAt: Date;
}

const PublicHolidaySchema = new mongoose.Schema<IPublicHoliday, Model<IPublicHoliday>>({
  ymd: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  kind: { type: String, enum: publicHolidayKinds, default: "custom" },
  active: { type: Boolean, default: true },
  seedKey: { type: String, unique: true, sparse: true },
  estimated: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() },
});

// a day the admin moved (or retitled) is the official one now
PublicHolidaySchema.pre("save", function () {
  if (!this.isNew && (this.isModified("ymd") || this.isModified("title"))) this.set("estimated", false);
});
PublicHolidaySchema.pre("findOneAndUpdate", function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = (update.$set || update) as Record<string, any>;
  if (("ymd" in set || "title" in set) && !("estimated" in set)) set.estimated = false;
});

PublicHolidaySchema.plugin(translatable);

const PublicHoliday = mongoose.model("PublicHoliday", PublicHolidaySchema);

export default PublicHoliday;
