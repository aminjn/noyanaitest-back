import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IDoctorProfile } from "../DoctorProfile";
import { IUserIdentity } from "../UserIdentity";
import { IPrescriptionItem } from "./PrescriptionItem";
import { ITaminPrescription2 } from "./TaminPrescription2";

export interface IPrescription2 extends MongoDoc {
  author: IDoctorProfile;
  createdAt: Date;
  patient: IUserIdentity;
  items?: IPrescriptionItem[];
  taminPrescriptions?: ITaminPrescription2[];
}

const Prescription2Schema = new mongoose.Schema<
  IPrescription2,
  Model<IPrescription2>
>(
  {
    author: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    createdAt: { type: Date, default: () => new Date() },
    patient: {
      type: mongoose.Schema.ObjectId,
      ref: "UserIdentity",
      required: true,
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

Prescription2Schema.virtual("items", {
  ref: "PrescriptionItem",
  localField: "_id",
  foreignField: "prescription",
});

Prescription2Schema.virtual("taminPrescriptions", {
  ref: "TaminPrescription2",
  localField: "_id",
  foreignField: "prescription",
});

const Prescription2 = mongoose.model("Prescription2", Prescription2Schema);

export default Prescription2;
