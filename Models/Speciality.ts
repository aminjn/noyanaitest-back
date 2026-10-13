import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ISpeciality extends MongoDoc {
  name?: string;
  slug?: string;
  image?: string;
  isHome: boolean;
  order: number;
  summary?: string;
  active: boolean;
  old?: mongoose.Types.ObjectId;
  description?: string;
  // the doctor's level an insurer's tariff reads (2026-10,
  // Models/InsuranceTariff.ts): a general practitioner, a specialist or a
  // subspecialist. Unset: guessed from the name (Lib/insuranceTariffs.ts)
  level?: "general" | "specialist" | "subspecialist";
  // the canonical catalogue (2026-10, Lib/catalog/specialityCanonical.ts):
  // the official list of Iran's medical council / ministry, seeded by
  // Lib/catalog/seedSpecialities.ts. Public lists show canonical and
  // admin-approved (active) entries; an import never adds one.
  canonical?: boolean;
  canonicalVersion?: number;
  tier?: "general" | "specialty" | "subspecialty" | "fellowship" | "allied";
  parent?: mongoose.Types.ObjectId;
  // other names it is written as («زنان» for «زنان و زایمان»): the import,
  // the duplicate finder and the site search match them
  synonyms: string[];
  // merged into another entry (Services/catalogCleanup.ts): inactive, out
  // of every list, its URL redirects to the target; reversible for 30 days
  archived?: boolean;
  archivedAt?: Date;
  mergedInto?: mongoose.Types.ObjectId;
}

const SpecialitySchema = new mongoose.Schema<ISpeciality, Model<ISpeciality>>(
  {
    name: { type: String, trim: true, required: true },
    slug: { type: String, trim: true, sparse: true, unique: true },
    image: { type: String },
    isHome: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    summary: { type: String, trim: true },
    active: { type: Boolean, default: false },
    old: { type: mongoose.Schema.ObjectId },
    description: { type: String },
    level: { type: String, enum: ["general", "specialist", "subspecialist"] },
    canonical: { type: Boolean, default: false, index: true },
    canonicalVersion: { type: Number },
    tier: { type: String, enum: ["general", "specialty", "subspecialty", "fellowship", "allied"] },
    parent: { type: mongoose.Schema.ObjectId, ref: "Speciality" },
    synonyms: { type: [{ type: String, trim: true }], default: [] },
    archived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date },
    mergedInto: { type: mongoose.Schema.ObjectId, ref: "Speciality" },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// A doctor belongs to a speciality when it is in their `specialities` (the
// main speciality is always one of them - see DoctorProfile's pre-validate),
// and only active doctors are shown or counted.
SpecialitySchema.virtual("doctors", {
  ref: "DoctorProfile",
  localField: "_id",
  foreignField: "specialities",
  match: { active: true },
});

SpecialitySchema.virtual("doctorsCountWithMainSpeciality", {
  ref: "DoctorProfile",
  localField: "_id",
  foreignField: "mainSpeciality",
  match: { active: true },
  count: true,
});

// every active doctor with this speciality (main or not): THE doctor count
SpecialitySchema.virtual("doctorsCountWithSideSpeciality", {
  ref: "DoctorProfile",
  localField: "_id",
  foreignField: "specialities",
  match: { active: true },
  count: true,
});

// an archived (merged) entry is never shown, whatever its flag says
SpecialitySchema.pre("validate", function (next) {
  if (this.get("archived")) this.set("active", false);
  next();
});

SpecialitySchema.plugin(translatable);

const Speciality = mongoose.model("Speciality", SpecialitySchema);

export default Speciality;
