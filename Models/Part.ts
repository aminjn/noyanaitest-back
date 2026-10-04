import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";

// Body regions of the public symptom map (/symptom, Components/Directory/
// BodyMap on the frontend): a body part is drawn on the map at its region.
// "general" = whole body (fever, fatigue...), not drawn, listed under the map.
export const partRegions = [
  "head",
  "neck",
  "chest",
  "abdomen",
  "pelvis",
  "back",
  "arms",
  "legs",
  "skin",
  "general",
] as const;
export type PartRegion = (typeof partRegions)[number];

// A body part / system (2026-10): the "by body part" entry of the medical
// directory (/disease/part/<slug>, /symptom/part/<slug>), the way Mayo
// Clinic, WebMD and Altibbi let a visitor browse conditions by body area.
// Symptoms link to parts (Symptom.part), diseases too (Disease.parts, plus
// the parts of their symptoms).
export interface IPart extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  region?: PartRegion;
  order: number;
  old?: mongoose.Types.ObjectId;
}

const PartSchema = new mongoose.Schema<IPart, Model<IPart>>({
  name: { type: String, trim: true, required: true },
  slug: { type: String, trim: true, unique: true, sparse: true },
  // parts saved before this switch existed are on (Lib/migrateMedicalDirectory)
  isActive: { type: Boolean, default: true },
  region: {
    type: String,
    enum: partRegions,
    // the admin form sends "" for "not set"
    set: (v: unknown) => (v === "" ? undefined : v),
  },
  order: { type: Number, default: 0 },
  old: { type: mongoose.Schema.ObjectId },
});

PartSchema.plugin(translatable);
clearsDirectoryCache(PartSchema);

const Part = mongoose.model("Part", PartSchema);

export default Part;
