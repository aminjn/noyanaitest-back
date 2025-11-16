import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { Gender, genders } from "./BecomeDoctorRequest";

export interface IPendingUser extends MongoDoc {
  phone: string;
  nationalCode?: string;
  firstName?: string;
  lastName?: string;
  fatherName?: string;
  gender?: Gender;
  identificationNumber?: string;
  identificationSerialCode?: string;
  identificationSerialNumber?: string;
  birthPlaceCode?: string;
  birthPlace?: string;
  birthDate?: Date;
  matched?: boolean;
}

const pendingUserSchema = new mongoose.Schema<
  IPendingUser,
  Model<IPendingUser>
>({
  phone: { type: String, unique: true, required: true },
  nationalCode: { type: String },
  firstName: { type: String },
  lastName: { type: String },
  fatherName: { type: String },
  gender: { type: String, enum: genders },
  identificationNumber: { type: String },
  identificationSerialCode: { type: String },
  identificationSerialNumber: { type: String },
  birthPlaceCode: { type: String },
  birthPlace: { type: String },
  birthDate: { type: Date },
  matched: { type: Boolean, default: false },
});

const PendingUser = mongoose.model("PendingUser", pendingUserSchema);

export default PendingUser;
