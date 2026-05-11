import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";
import { IDoctorProfile } from "./DoctorProfile";

export interface IVisitPrescription extends MongoDoc {
  patient: IUserIdentity;
  author: IDoctorProfile;
  createdAt: Date;
  taminId: string;
  tracking: string;
}

const VisitPrescriptionSchema = new mongoose.Schema<
  IVisitPrescription,
  Model<IVisitPrescription>
>({
  patient: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
  author: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  createdAt: { type: Date, default: () => new Date() },
  taminId: { type: String },
  tracking: { type: String },
});

const VisitPrescription = mongoose.model(
  "VisitPrescription",
  VisitPrescriptionSchema,
);

export default VisitPrescription;
