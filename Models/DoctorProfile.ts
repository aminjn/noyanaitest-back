import { translatable } from "../Lib/i18n/translatable";
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
  tier?: DoctorProfileTier;
  averageScore: number;
  feedbackCount: number;
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
    slug: { type: String },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    popular: { type: Boolean, default: false },
    tier: { type: String, enum: doctorProfileTiers },
    province: { type: mongoose.Schema.ObjectId, ref: "Province" },
    city: { type: mongoose.Schema.ObjectId, ref: "City" },
    district: { type: mongoose.Schema.ObjectId, ref: "District" },
    averageScore: { type: Number, default: 0 },
    feedbackCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

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

const DoctorProfile = mongoose.model("DoctorProfile", DoctorProfileSchema);

export default DoctorProfile;
