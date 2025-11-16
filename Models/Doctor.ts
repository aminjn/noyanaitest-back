import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";

export interface IDoctor extends MongoDoc {
  //general
  name?: string;
  slug?: string;
  image?: string;
  code?: string;
  hours?: string;
  awards?: string;
  birthDate?: Date;
  description?: string;
  summary?: string;
  images?: string[];
  order?: number;
  active?: boolean;

  //contact
  address?: string;
  landLine?: string;
  mobile?: string;
  lng?: number;
  lat?: number;
  email?: string;
  province?: Province;
  city?: City;

  //social
  site?: string;
  telegram?: string;
  twitter?: string;
  youtube?: string;
  aparat?: string;
  linkedin?: string;
  instagram?: string;

  //ref
  speciality?: ISpeciality;
  specialities?: ISpeciality[];

  //migration
  old: mongoose.Types.ObjectId;
}

const DoctorSchema = new mongoose.Schema<IDoctor, Model<IDoctor>>(
  {
    name: { type: String },
    slug: { type: String },
    image: { type: String },
    code: { type: String },
    hours: { type: String },
    awards: { type: String },
    birthDate: { type: Date },
    description: { type: String },
    summary: { type: String },
    images: { type: [{ type: String, required: true }], default: [] },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: false },
    address: { type: String },
    landLine: { type: String },
    mobile: { type: String },
    lng: { type: String },
    lat: { type: String },
    email: { type: String },
    province: { type: String, enum: provinceSlugs },
    city: { type: String, enum: citySlugs },
    site: { type: String },
    telegram: { type: String },
    twitter: { type: String },
    youtube: { type: String },
    aparat: { type: String },
    linkedin: { type: String },
    instagram: { type: String },
    speciality: { type: mongoose.Schema.ObjectId, ref: "Speciality" },
    specialities: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Speciality", required: true },
      ],
      default: [],
    },
    old: { type: mongoose.Schema.ObjectId },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

DoctorSchema.virtual("gallery", {
  ref: "GalleryItem",
  localField: "_id",
  foreignField: "owner",
});

const Doctor = mongoose.model("Doctor", DoctorSchema);

export default Doctor;
