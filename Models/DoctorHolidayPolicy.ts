import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

// A doctor's choice for the official holidays (2026-10, Lib/publicHolidays.ts).
// No record: closed on every holiday (the default, as most offices in Iran
// are). `works` is the global switch; `open` / `closed` are the days the
// doctor chose against it, Tehran "YYYY-MM-DD" days. A day in `open` takes
// visits, a day in `closed` doesn't, whatever the switch says.
export interface IDoctorHolidayPolicy extends MongoDoc {
  doctor: IDoctorProfile;
  works: boolean;
  open: string[];
  closed: string[];
  updatedAt: Date;
}

const ymd = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };

const DoctorHolidayPolicySchema = new mongoose.Schema<IDoctorHolidayPolicy, Model<IDoctorHolidayPolicy>>({
  doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile", required: true, unique: true },
  works: { type: Boolean, default: false },
  open: { type: [ymd], default: [] },
  closed: { type: [ymd], default: [] },
  updatedAt: { type: Date, default: () => new Date() },
});

const DoctorHolidayPolicy = mongoose.model("DoctorHolidayPolicy", DoctorHolidayPolicySchema);

export default DoctorHolidayPolicy;
