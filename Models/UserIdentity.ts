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
  // the insurances this person uses (2026-10): remembered from their
  // bookings, preselected on the next one (Lib/insuranceTariffs.ts)
  insurances?: { insurance: mongoose.Types.ObjectId; plan?: mongoose.Types.ObjectId | null }[];
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
      },
    ],
    default: undefined,
  },
});

const UserIdentity = mongoose.model("UserIdentity", UserIdentitySchema);

export default UserIdentity;
