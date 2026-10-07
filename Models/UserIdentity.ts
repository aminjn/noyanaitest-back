import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { Gender, genders } from "./BecomeDoctorRequest";

export interface IUserIdentity extends MongoDoc {
  user?: IUser;
  nationalId: string;
  givenName: string;
  lastName: string;
  gender: Gender;
  dateOfbirth: Date;
  fatherName: string;
  identificationNumber: string;
  identificationSerialCode: string;
  identificationSerialNumber: string;
  birthPlaceCode: string;
  birthPlace: string;
  phones: string[];
  // the insurances this person uses (2026-10, «بیمه‌های من»,
  // Lib/patientInsurances.ts): at most one basic and one supplementary,
  // kept by the patient on their dashboard and preselected on every
  // booking (Lib/insuranceTariffs.ts). A booking still remembers what it
  // used when nothing of that kind is saved yet.
  insurances?: IIdentityInsurance[];
}

export interface IIdentityInsurance {
  insurance: mongoose.Types.ObjectId;
  plan?: mongoose.Types.ObjectId | null;
  // شماره‌ی بیمه / شماره‌ی عضویت (the card's number)
  memberNumber?: string;
  // the card's last valid day (a Tehran day's end); none: no expiry
  expiresAt?: Date | null;
  // "manual": the patient saved it; "booking": remembered from a booking
  source?: "manual" | "booking";
  updatedAt?: Date;
}

const UserIdentitySchema = new mongoose.Schema<
  IUserIdentity,
  Model<IUserIdentity>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    unique: true,
    sparse: true,
  },
  nationalId: { type: String, required: true },
  givenName: { type: String, required: true },
  lastName: { type: String, required: true },
  gender: { type: String, enum: genders, required: true },
  dateOfbirth: { type: Date, required: true },
  fatherName: { type: String },
  identificationNumber: { type: String },
  identificationSerialCode: { type: String },
  identificationSerialNumber: { type: String },
  birthPlaceCode: { type: String },
  birthPlace: { type: String },
  phones: { type: [{ type: String }], default: [] },
  insurances: {
    type: [
      {
        _id: false,
        insurance: { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
        plan: { type: mongoose.Schema.ObjectId, ref: "InsurancePlan", default: null },
        memberNumber: { type: String, trim: true, maxlength: 40 },
        expiresAt: { type: Date, default: null },
        source: { type: String, enum: ["manual", "booking"], default: "booking" },
        updatedAt: { type: Date },
      },
    ],
    default: undefined,
  },
});

const UserIdentity = mongoose.model("UserIdentity", UserIdentitySchema);

export default UserIdentity;
