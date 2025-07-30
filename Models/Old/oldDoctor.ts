import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IOldUser } from "./oldUser";
import { IOldSpeciality } from "./oldSpeciality";

export interface IOldDoctor extends MongoDoc {
  name: string;
  link?: string;
  image?: string;
  address?: string;
  landLine?: string;
  mobile?: string;
  speciality?: IOldSpeciality;

  code?: string;

  lng?: number;
  lat?: number;
  hours?: string;
  //New
  awards?: string;
  birthDate?: Date;
  colleagues: IOldDoctor[];
  description?: string;
  summary?: string;
  email?: string;
  user?: IOldUser;
  specialities: IOldSpeciality[];
  images: string[];
  //   availabilities: IAvailability[];
  instagram?: string;
  telegram?: string;
  twitter?: string;
  youtube?: string;
  aparat?: string;
  linkedin?: string;
  province?: string;
  newCity?: string;
  visitation: number;

  order: number;
  active: boolean;
  special: boolean;
  isHome: boolean;
  isMain: boolean;

  newSpecial?: Date;
  newHome?: Date;

  //   closestSession?: IAvailability | null;

  clinic?: string;
  hospital?: string;
}

const doctorSchema = new mongoose.Schema<IOldDoctor, Model<IOldDoctor>>(
  {
    code: { type: String },
    name: { type: String, required: true, trim: true, unique: true },
    link: {
      type: String,
      trim: true,
      match: /https?:\/\/([^\s\/$.?#\-]+\.[^\s\/]+)/,
    },
    image: { type: String },
    speciality: {
      type: mongoose.Schema.ObjectId,
      ref: "Speciality",
    },
    specialities: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Speciality", required: true },
      ],
      default: [],
    },
    order: { type: Number, default: 0 },
    address: { type: String, trim: true, match: /^\s*(\S.{2,})\s*$/ },
    landLine: { type: String, trim: true },
    mobile: { type: String, trim: true },
    active: { type: Boolean, default: true },
    special: { type: Boolean, default: false },
    lng: { type: Number, min: -180, max: 180 },
    lat: { type: Number, min: -90, max: 90 },
    hours: { type: String },
    awards: { type: String },
    birthDate: { type: Date },
    colleagues: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "Doctor" }],
      default: [],
    },
    description: { type: String },
    summary: { type: String, match: /^\s*(\S.{2,})\s*$/ },
    email: {
      type: String,
      match: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    },
    user: { type: mongoose.Schema.ObjectId, ref: "User", sparse: true },
    images: { type: [{ type: String }], default: [] },
    instagram: { type: String, match: /^[a-zA-Z0-9._]+$/ },
    telegram: { type: String, match: /^[a-zA-Z0-9._]+$/ },
    twitter: { type: String, match: /^[a-zA-Z0-9._]+$/ },
    youtube: { type: String, match: /^[a-zA-Z0-9._]+$/ },
    aparat: { type: String },
    linkedin: { type: String, match: /^[a-zA-Z0-9-]{3,100}$/ },
    newCity: { type: String },
    province: { type: String },
    visitation: { type: Number, default: 0 },
    isHome: { type: Boolean, default: false },
    isMain: { type: Boolean, default: false },
    newSpecial: { type: Date },
    newHome: { type: Date },
    clinic: { type: String },
    hospital: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

doctorSchema.virtual("availabilities", {
  ref: "Availability",
  localField: "_id",
  foreignField: "doctor",
});

doctorSchema.virtual("closestSession", {
  ref: "Availability",
  localField: "_id",
  foreignField: "doctor",
  justOne: true,
  match: function () {
    const then = new Date();
    const hour = then.getHours() + 1;
    then.setHours(0, 0, 0, 0);
    return {
      $or: [
        {
          time: { $eq: then },
          sessions: { $elemMatch: { "start.hour": { $gt: hour } } },
        },
        { time: { $gte: then } },
      ],
    };
  },
});

doctorSchema.virtual("blogs", {
  ref: "Blog",
  localField: "_id",
  foreignField: "owner",
});

doctorSchema.virtual("publishedBlogs", {
  ref: "Blog",
  localField: "_id",
  foreignField: "owner",
  match: { status: "Publish" },
});

doctorSchema.virtual("comments", {
  ref: "Comment",
  localField: "_id",
  foreignField: "doc",
  match: { status: "Approved" },
});

doctorSchema.virtual("offices", {
  ref: "Office",
  localField: "_id",
  foreignField: "doctor",
});

doctorSchema.virtual("clicks", {
  ref: "Click",
  localField: "_id",
  foreignField: "doctor",
});

doctorSchema.virtual("commentCount", {
  ref: "Comment",
  localField: "_id",
  foreignField: "doc",
  count: true,
});

const OldDoctor = mongoose.connection
  .useDb("Noyan")
  .model("Doctor", doctorSchema);

export default OldDoctor;
