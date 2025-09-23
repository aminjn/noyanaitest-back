import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { IPhoneConsultSettings } from "./DoctorPhoneConsultSettings";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";
import { Gender, genders, MedicalSystemTitle } from "./BecomeDoctorRequest";
import { getSessionDateKey } from "../Lib/helpers";

export interface IDoctorProfile extends MongoDoc {
  user?: IUser;
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
  province?: Province;
  city?: City;
  address?: string;
  lat?: number;
  lng?: number;
  phoneConsultSettings?: IPhoneConsultSettings;
  active: boolean;
  order: number;
  avatar?: string;
  slug?: string;
  location?: any;
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
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    ssid: { type: String },
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
    province: { type: String, enum: provinceSlugs },
    city: { type: String, enum: citySlugs },
    active: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    avatar: { type: String },
    slug: { type: String },
    location: {
      type: { type: String, enum: ["Point"], required: true, default: "Point" },
      coordinates: { type: [Number], required: true },
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

DoctorProfileSchema.virtual("phoneConsultSettings", {
  ref: "PhoneConsultSettings",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
});

DoctorProfileSchema.virtual("gallery", {
  ref: "GalleryItem",
  localField: "_id",
  foreignField: "owner",
});

DoctorProfileSchema.index({ location: "2dsphere" });

const DoctorProfile = mongoose.model("DoctorProfile", DoctorProfileSchema);

export default DoctorProfile;
