import { translatable } from "../Lib/i18n/translatable";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { IPhoneConsultSettings } from "./DoctorPhoneConsultSettings";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { Gender, genders, MedicalSystemTitle } from "./BecomeDoctorRequest";
import { getSessionDateKey } from "../Lib/helpers";
import { IMcCode } from "./McCode";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";

export const doctorProfileTiers = [
  "expert",
  "specialist",
  "superSpecialist",
] as const;
export type DoctorProfileTier = (typeof doctorProfileTiers)[number];

export interface IDoctorProfile extends MongoDoc {
  user?: IUser;
  mcCode?: IMcCode;
  firstName?: string;
  lastName?: string;
  ssid?: string;
  gender?: Gender;
  mainSpeciality?: ISpeciality;
  specialities: ISpeciality[];
  medicalSystemTitle?: MedicalSystemTitle;
  medicalSystemCode?: string;
  introduction?: string;
  services: string[];
  achivements: string[];
  website?: string;
  landLine?: string;
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  address?: string;
  lat?: number;
  lng?: number;
  phoneConsultSettings?: IPhoneConsultSettings;
  active: boolean;
  order: number;
  avatar?: string;
  slug?: string;
  location?: { type: "Point"; coordinates?: [number, number] };
  popular: boolean;
  claimed?: boolean;
  legacyDoctor?: mongoose.Types.ObjectId;
  tier?: DoctorProfileTier;
  averageScore: number;
  feedbackCount: number;
  recommendCount: number;
}

const DoctorProfileSchema = new mongoose.Schema<
  IDoctorProfile,
  Model<IDoctorProfile>
>(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      unique: true,
      sparse: true,
    },
    mcCode: { type: mongoose.Schema.ObjectId, ref: "McCode" },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    // national ID: private - never returned unless a query asks for it
    // (+ssid), so public doctor endpoints and populated owners can't leak it
    ssid: { type: String, select: false },
    gender: { type: String, enum: genders },
    mainSpeciality: { type: mongoose.Schema.ObjectId, ref: "Speciality" },
    specialities: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Speciality", required: true },
      ],
      default: [],
    },
    medicalSystemCode: { type: String, trim: true },
    introduction: { type: String },
    services: { type: [String], default: [] },
    achivements: { type: [String], default: [] },
    website: { type: String, trim: true },
    landLine: { type: String },
    address: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    active: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    avatar: { type: String },
    slug: { type: String, unique: true, sparse: true },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    popular: { type: Boolean, default: false },
    // false = imported from the old public directory (no account yet): shown
    // with the same card, but not bookable until the doctor claims it (an
    // approved "become a doctor" request with the same council code links it)
    claimed: { type: Boolean, default: true },
    // the legacy Doctor document this profile was created from
    legacyDoctor: { type: mongoose.Schema.ObjectId },
    tier: { type: String, enum: doctorProfileTiers },
    province: { type: mongoose.Schema.ObjectId, ref: "Province" },
    city: { type: mongoose.Schema.ObjectId, ref: "City" },
    district: { type: mongoose.Schema.ObjectId, ref: "District" },
    averageScore: { type: Number, default: 0 },
    feedbackCount: { type: Number, default: 0 },
    recommendCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// Speciality invariant (2026-09): a doctor is attached to specialities
// directly; the main one (shown on the card) is always among them, with no
// duplicates, and a doctor with specialities but no main one gets the first.
export const normalizeDoctorSpecialities = (doc: {
  mainSpeciality?: unknown;
  specialities?: unknown[];
}) => {
  const ids = [doc.mainSpeciality, ...(doc.specialities || [])]
    .filter(Boolean)
    .map((el) => String((el as { _id?: unknown })?._id ?? el));
  const unique = ids.filter((el, i) => ids.indexOf(el) === i);
  return { mainSpeciality: unique[0], specialities: unique };
};

DoctorProfileSchema.pre("validate", function (next) {
  const { mainSpeciality, specialities } = normalizeDoctorSpecialities(this as never);
  if (specialities.length) {
    this.set("specialities", specialities);
    if (!this.get("mainSpeciality")) this.set("mainSpeciality", mainSpeciality);
  }
  next();
});

// updates (admin edit, the doctor's own profile form) skip validate hooks:
// re-apply the same invariant on the saved document
DoctorProfileSchema.post("findOneAndUpdate", async function (doc) {
  if (!doc?._id) return;
  // the query may have returned the pre-update document: read it fresh
  const model = (this as unknown as { model: Model<IDoctorProfile> }).model;
  const fresh = await model
    .findById(doc._id)
    .select("mainSpeciality specialities")
    .lean();
  if (!fresh) return;
  const fixed = normalizeDoctorSpecialities(fresh);
  const current = (fresh.specialities || []).map(String);
  const sameList =
    current.length === fixed.specialities.length &&
    current.every((el, i) => el === fixed.specialities[i]);
  if (sameList && (fresh.mainSpeciality || !fixed.mainSpeciality)) return;
  await model.updateOne(
    { _id: doc._id },
    {
      $set: {
        specialities: fixed.specialities,
        ...(fresh.mainSpeciality ? {} : { mainSpeciality: fixed.mainSpeciality }),
      },
    },
  );
});

DoctorProfileSchema.virtual("phoneConsultSettings", {
  ref: "PhoneConsultSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});

DoctorProfileSchema.virtual("sipCallSettings", {
  ref: "SipCallSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});

DoctorProfileSchema.virtual("textChatSettings", {
  ref: "TextChatSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});

DoctorProfileSchema.virtual("videoCallSettings", {
  ref: "VideoCallSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});
DoctorProfileSchema.virtual("inPersonSettings", {
  ref: "InPersonSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});
DoctorProfileSchema.virtual("voiceCallSettings", {
  ref: "VoiceCallSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});

DoctorProfileSchema.virtual("gallery", {
  ref: "GalleryItem",
  localField: "_id",
  foreignField: "owner",
});

DoctorProfileSchema.virtual("offices", {
  ref: "Office",
  localField: "_id",
  foreignField: "doctor",
});

DoctorProfileSchema.virtual("socials", {
  ref: "DoctorSocialMedia",
  localField: "_id",
  foreignField: "doctor",
});

DoctorProfileSchema.index({ location: "2dsphere" });

DoctorProfileSchema.virtual("shifts", {
  ref: "DoctorShift",
  localField: "_id",
  foreignField: "doctor",
});

DoctorProfileSchema.virtual("availabilities", {
  ref: "DoctorAvailibility",
  localField: "_id",
  foreignField: "doctor",
});

DoctorProfileSchema.plugin(translatable);

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
DoctorProfileSchema.plugin(geoFromPointPlugin, {
  modelName: "DoctorProfile",
  fields: { province: "province", city: "city", district: "district" },
});

const DoctorProfile = mongoose.model("DoctorProfile", DoctorProfileSchema);

export default DoctorProfile;
