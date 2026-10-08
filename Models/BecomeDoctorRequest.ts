import mongoose, { Model, mongo } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ISpeciality } from "./Speciality";
import { Province, provinceSlugs } from "../Lib/Provinces";
import { City, citySlugs } from "../Lib/Cities";

export const genders = ["male", "female"] as const;

export type Gender = (typeof genders)[number];

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

export type MedicalSystemTitle = (typeof medicalSystemTitles)[number];

export const becomeANodeStatuses = ["Pending", "Rejected", "Approved"] as const;

export type BecomeANodeStatus = (typeof becomeANodeStatuses)[number];

// How the council code was checked (2026-10, one onboarding flow):
// "inquiry" - the medical council's service confirmed the code belongs to
// the applicant's national id; "manual" - the service was unavailable, the
// applicant typed it and an admin checks it against the council card.
// Requests from the old form carry neither.
export const councilVerifications = ["inquiry", "manual"] as const;
export type CouncilVerification = (typeof councilVerifications)[number];

// the uploaded documents (private files, Controllers/doctorOnboardingController.ts)
export const onboardingDocFields = ["councilCard", "licenseDoc", "officePermit"] as const;
export type OnboardingDocField = (typeof onboardingDocFields)[number];

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
  // old form only: the practice address is set up in the panel's offices now
  province?: Province;
  city?: City;
  address?: string;
  description?: string;
  verification?: CouncilVerification;
  // what the council's inquiry returned for the code (degree title, city, date)
  council?: { title?: string; city?: string; acquiredAt?: string };
  mcCode?: mongoose.Types.ObjectId;
  // an existing page (old directory / unclaimed) with this council code that
  // approval hands to the applicant instead of creating a second one
  claimProfile?: mongoose.Types.ObjectId;
  councilCard?: string;
  licenseDoc?: string;
  officePermit?: string;
  status: BecomeANodeStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
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
  province: { type: String, enum: provinceSlugs },
  city: { type: String, enum: citySlugs },
  address: { type: String },
  description: { type: String },
  verification: { type: String, enum: councilVerifications },
  council: {
    title: { type: String },
    city: { type: String },
    acquiredAt: { type: String },
  },
  mcCode: { type: mongoose.Schema.ObjectId, ref: "McCode" },
  claimProfile: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  councilCard: { type: String },
  licenseDoc: { type: String },
  officePermit: { type: String },
  status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
  rejectReason: { type: String },
  decidedAt: { type: Date },
});

const BecomeDoctorRequest = mongoose.model(
  "BecomeDoctorRequest",
  BecomeDoctorRequestSchema,
);

export default BecomeDoctorRequest;
