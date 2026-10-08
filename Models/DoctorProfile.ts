import { translatable } from "../Lib/i18n/translatable";
import { IProviderStatusFields, providerStatusPlugin } from "../Lib/providerStatus";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { IPhoneConsultSettings } from "./DoctorPhoneConsultSettings";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { Gender, genders, MedicalSystemTitle, medicalSystemTitles } from "./BecomeDoctorRequest";
import AppError from "../Lib/AppError";
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

export interface IDoctorProfile extends MongoDoc, IProviderStatusFields {
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
  // a self-onboarded draft that publishes itself when bookable
  // (Lib/doctorPublish.ts); an admin's own publish / hide ends it
  autoPublish?: boolean;
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
    // «پزشک / دندانپزشک / ماما ...» from the become-doctor request: it was in
    // the interface only, so every save dropped it
    medicalSystemTitle: { type: String, enum: medicalSystemTitles },
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
    autoPublish: { type: Boolean, default: false },
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

// Two rules a published doctor page needs (2026-10, doctor profile audit):
// - a page on the site has a name and at least one speciality: an active
//   doctor without one was in no speciality list or filter, and the card
//   showed a blank speciality line (the admin form and the approval could
//   publish one);
// - one council code, one doctor: the code is how a doctor claims their
//   page, so a second profile with the same code made the claim pick one
//   at random and listed the doctor twice.
// Written for save and for updates (admin edit, the panel's own form);
// imports and the automatic publish write through the collection.
export const DOCTOR_PUBLISH_INCOMPLETE_ERROR =
  "برای نمایش پزشک در سایت، نام، نام خانوادگی و دست‌کم یک تخصص لازم است";
export const DOCTOR_CODE_TAKEN_ERROR = "این کد نظام پزشکی برای پزشک دیگری ثبت شده است";

const truthy = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

const codeTaken = async (model: Model<IDoctorProfile>, code: unknown, selfId?: unknown) => {
  const text = typeof code === "string" ? code.trim() : "";
  if (!text) return false;
  return !!(await model.exists({ medicalSystemCode: text, ...(selfId ? { _id: { $ne: selfId } } : {}) }));
};

DoctorProfileSchema.pre("save", async function () {
  const model = this.constructor as Model<IDoctorProfile>;
  if ((this.isNew || this.isModified("medicalSystemCode")) && (await codeTaken(model, this.get("medicalSystemCode"), this._id)))
    throw new AppError(DOCTOR_CODE_TAKEN_ERROR, 400);
  const publishing = this.get("active") && (this.isNew || this.isModified("active") || this.isModified("specialities") || this.isModified("mainSpeciality"));
  if (
    publishing &&
    (!this.get("firstName") || !this.get("lastName") || !(this.get("specialities") || []).length)
  )
    throw new AppError(DOCTOR_PUBLISH_INCOMPLETE_ERROR, 400);
});

DoctorProfileSchema.pre("findOneAndUpdate", async function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = { ...update, ...(update.$set || {}) } as Record<string, any>;
  const unset = (update.$unset || {}) as Record<string, unknown>;
  const touches = ["active", "firstName", "lastName", "mainSpeciality", "specialities"].some(
    (key) => key in set || key in unset,
  );
  if (!touches && !("medicalSystemCode" in set)) return;
  const current = await this.model
    .findOne(this.getFilter())
    .select("active firstName lastName mainSpeciality specialities medicalSystemCode")
    .lean<Record<string, any>>();
  if (!current) return;
  // only a changed code is checked: an old duplicate pair (imports) must not
  // block every other edit of those two records
  const newCode = typeof set.medicalSystemCode === "string" ? set.medicalSystemCode.trim() : "";
  if (
    newCode &&
    newCode !== String(current.medicalSystemCode || "").trim() &&
    (await codeTaken(this.model as never, newCode, current._id))
  )
    throw new AppError(DOCTOR_CODE_TAKEN_ERROR, 400);
  if (!touches) return;
  const after = (key: string) => (key in unset ? undefined : key in set ? set[key] : current[key]);
  const active = "active" in set ? truthy(set.active) : !!current.active;
  if (!active) return;
  const specs = [after("mainSpeciality"), ...((after("specialities") as unknown[]) || [])].filter(Boolean);
  const name = (v: unknown) => typeof v === "string" && !!v.trim();
  if (!name(after("firstName")) || !name(after("lastName")) || !specs.length)
    throw new AppError(DOCTOR_PUBLISH_INCOMPLETE_ERROR, 400);
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
// suspension by an admin, distinct from draft (Lib/providerStatus.ts)
// an admin publishing or hiding the page decides from then on: the
// automatic publish rule (Lib/doctorPublish.ts) stops for this doctor
DoctorProfileSchema.pre("findOneAndUpdate", function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = (update.$set || update) as Record<string, any>;
  if ("active" in set && !("autoPublish" in set)) set.autoPublish = false;
});

DoctorProfileSchema.plugin(providerStatusPlugin, { activeField: "active" });

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
DoctorProfileSchema.plugin(geoFromPointPlugin, {
  modelName: "DoctorProfile",
  fields: { province: "province", city: "city", district: "district" },
});

const DoctorProfile = mongoose.model("DoctorProfile", DoctorProfileSchema);

export default DoctorProfile;
