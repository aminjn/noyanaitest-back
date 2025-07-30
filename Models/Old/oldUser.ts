import mongoose, { Model } from "mongoose";
import { IOldDoctor } from "./oldDoctor";
import { MongoDoc } from "../User";

export const userRoles = ["user", "admin", "haji"] as const;

export const licenses = ["free", "bronze", "silver", "gold"] as const;

export const licenseDict: { [key in (typeof licenses)[number]]: string } = {
  free: "رایگان",
  bronze: "برنزی",
  silver: "نقره ای",
  gold: "طلایی",
};

export const licensePrice: { [key in (typeof licenses)[number]]: number } = {
  free: 0,
  bronze: 12500000,
  silver: 40000000,
  gold: 10000000,
};

export const licenseDuration: { [key in (typeof licenses)[number]]: number } = {
  free: 0,
  bronze: 30,
  silver: 30,
  gold: 30,
};

export interface IOldUser extends MongoDoc {
  phone: string;
  role: (typeof userRoles)[number];
  gender?: string;
  birth?: number;
  name?: string;
  doctor?: IOldDoctor;
  firstName?: string;
  lastName?: string;
  ssid?: string;
  image?: string;
  exactBirth?: Date;
  license: (typeof licenses)[number];
  licenseExpiration?: Date;
  balance: number;
}

const userSchema = new mongoose.Schema<IOldUser, Model<IOldUser>>(
  {
    name: { type: String, trim: true },
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    role: { type: String, enum: userRoles, default: "user" },
    gender: { type: String },
    birth: {
      type: Number,
    },
    firstName: { type: String },
    lastName: { type: String },
    ssid: {
      type: String,
    },
    image: { type: String },
    exactBirth: { type: Date },
    license: { type: String, default: "free" },
    licenseExpiration: { type: Date },
    balance: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true } }
);

userSchema.virtual("detections", {
  ref: "Detection",
  localField: "_id",
  foreignField: "owner",
});

userSchema.virtual("doctor", {
  ref: "Doctor",
  localField: "_id",
  foreignField: "user",
  justOne: true,
});

userSchema.virtual("patterns", {
  ref: "Pattern",
  localField: "_id",
  foreignField: "user",
});

userSchema.virtual("history", {
  ref: "MedicalHistory",
  localField: "_id",
  foreignField: "user",
  justOne: true,
});

const OldUser = mongoose.connection.useDb("Noyan").model("User", userSchema);

export default OldUser;
