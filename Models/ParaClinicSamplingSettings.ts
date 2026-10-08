import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";
import { ICity } from "./Geo/City";

// A lab's sampling schedule (2026-10, owner decision; Halodoc / SnappDoctor
// lab pattern). Unlike a doctor's shift (one patient per visit), a lab takes
// several patients in the same slot: every slot has a capacity.
//
//   enabled      -> patients pick an in-lab sampling time at checkout for a
//                   test that needs one (ParaClinicTest.sampling). Off: the
//                   lab's tests sell as before, with no time.
//   hours        -> weekly opening ranges for sampling; `day` is the shift
//                   day index (0 = Saturday ... 6 = Friday, as DoctorShift),
//                   start / end are minutes after Tehran midnight
//   slotMinutes  -> length of an in-lab slot; `capacity` patients each
//   closedDays   -> "YYYY-MM-DD" Tehran days with no sampling (holidays)
//   horizonDays  -> how far ahead a patient may book
//   leadMinutes  -> the earliest slot is this far from now
//   home         -> home sampling: a fee, the cities it serves, and time
//                   windows of `windowMinutes` cut from the same weekly
//                   hours, `capacity` visits each. Its `enabled` is what the
//                   public "home sampling" badge (ParaClinic.onPremises) shows.
export interface ISamplingHours {
  day: number;
  start: number;
  end: number;
}

export interface IParaClinicSamplingSettings extends MongoDoc {
  paraClinic: IParaClinic;
  enabled: boolean;
  hours: ISamplingHours[];
  slotMinutes: number;
  capacity: number;
  closedDays: string[];
  horizonDays: number;
  leadMinutes: number;
  home: {
    enabled: boolean;
    fee: number;
    cities: ICity[];
    windowMinutes: number;
    capacity: number;
  };
}

export const SAMPLING_DEFAULTS = {
  slotMinutes: 15,
  capacity: 3,
  horizonDays: 14,
  leadMinutes: 120,
  homeWindowMinutes: 120,
  homeCapacity: 2,
};

const ParaClinicSamplingSettingsSchema = new mongoose.Schema<
  IParaClinicSamplingSettings,
  Model<IParaClinicSamplingSettings>
>({
  paraClinic: {
    type: mongoose.Schema.ObjectId,
    ref: "ParaClinic",
    required: true,
    unique: true,
  },
  enabled: { type: Boolean, default: false },
  hours: {
    type: [
      {
        _id: false,
        day: { type: Number, min: 0, max: 6, required: true },
        start: { type: Number, min: 0, max: 1440, required: true },
        end: { type: Number, min: 0, max: 1440, required: true },
      },
    ],
    default: [],
  },
  slotMinutes: { type: Number, min: 5, max: 240, default: SAMPLING_DEFAULTS.slotMinutes },
  capacity: { type: Number, min: 1, max: 100, default: SAMPLING_DEFAULTS.capacity },
  closedDays: { type: [{ type: String, match: /^\d{4}-\d{2}-\d{2}$/ }], default: [] },
  horizonDays: { type: Number, min: 1, max: 60, default: SAMPLING_DEFAULTS.horizonDays },
  leadMinutes: { type: Number, min: 0, max: 2880, default: SAMPLING_DEFAULTS.leadMinutes },
  home: {
    enabled: { type: Boolean, default: false },
    fee: { type: Number, min: 0, default: 0 },
    cities: { type: [{ type: mongoose.Schema.ObjectId, ref: "City" }], default: [] },
    windowMinutes: { type: Number, min: 30, max: 480, default: SAMPLING_DEFAULTS.homeWindowMinutes },
    capacity: { type: Number, min: 1, max: 50, default: SAMPLING_DEFAULTS.homeCapacity },
  },
});

const ParaClinicSamplingSettings = mongoose.model(
  "ParaClinicSamplingSettings",
  ParaClinicSamplingSettingsSchema,
);

export default ParaClinicSamplingSettings;
