import mongoose, { Model, mongo } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";

export const genders = ["male", "female"] as const;

type Gender = (typeof genders)[number];

export const medicalSystemTitles = [
  "دندانپزشکی",
  "پزشکی",
  "مامایی",
  "داروسازی",
  "تغذیه",
  "فیزیوتراپی",
  "آزمایشگاهی (بالینی)",
  "گفتار درمانی",
  "کاردرمانی",
  "بینایی سنجی",
  "شنوایی سنجی",
  "علوم آزمایشگاهی",
  "ارتز و پروتز",
  "اتباع خارجی",
  "کایروپراکتیک",
  "ناتروپاتی",
] as const;

type MedicalSystemTitle = (typeof medicalSystemTitles)[number];

const becomeDoctorStatuses = ["Pending", "Rejected", "Approved"] as const;

type BecomeDoctorStatus = (typeof becomeDoctorStatuses)[number];

export interface IBecomeDoctorRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  firstName: string;
  lastName: string;
  ssid: string;
  gender: Gender;
  medicalSystemTitle: MedicalSystemTitle;
  medicalSystemCode: string;
  specialities: ISpeciality[];
  province: Province;
  city: City;
  address: string;
  description?: string;
  status: BecomeDoctorStatus;
}

const BecomeDoctorRequestSchema = new mongoose.Schema<
  IBecomeDoctorRequest,
  Model<IBecomeDoctorRequest>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    unique: true,
    required: true,
    ref: "User",
  },
  createdAt: { type: Date, default: () => new Date() },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  ssid: { type: String, required: true },
  gender: { type: String, required: true, enum: genders },
  medicalSystemTitle: {
    type: String,
    required: true,
    enum: medicalSystemTitles,
  },
  medicalSystemCode: { type: String, required: true },
  specialities: {
    type: [
      { type: mongoose.Schema.ObjectId, ref: "Speciality", required: true },
    ],
    default: [],
    required: true,
  },
  province: { type: String, required: true, enum: provinceSlugs },
  city: { type: String, required: true, enum: citySlugs },
  address: { type: String, required: true },
  description: { type: String },
  status: { type: String, enum: becomeDoctorStatuses, default: "Pending" },
});

const BecomeDoctorRequest = mongoose.model(
  "BecomeDoctorRequest",
  BecomeDoctorRequestSchema
);

export default BecomeDoctorRequest;
