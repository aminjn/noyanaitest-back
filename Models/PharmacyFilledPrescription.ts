import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import { IPharmacyTaminPrescription } from "./PharmacyTaminPrescription";

export interface IPharmacyFilledPrescription extends MongoDoc {
  pharmacy: IPharmacy;
  submittedAt: Date;
  prescription: IPharmacyTaminPrescription;
  requestId: number;
  requestPrice: number;
  regdate: string;
  phaRequestPrice: number;
  isNotePatient: number;
  docId: string;
  docFName: string;
  docLName: string;
  userId: string;
  phaId: string;
  month: string;
  year: string;
  prescDate: string;
  patientAmount: number;
  custServiceType: string;
  docspec: string;
  custServiceTypeDesc: string;
}

const PharmacyFilledPrescriptionSchema = new mongoose.Schema<
  IPharmacyFilledPrescription,
  Model<IPharmacyFilledPrescription>
>(
  {
    pharmacy: {
      type: mongoose.Schema.ObjectId,
      ref: "Pharmacy",
      required: true,
    },
    submittedAt: { type: Date, default: () => new Date() },
    prescription: {
      type: mongoose.Schema.ObjectId,
      ref: "PharmacyTaminPrescription",
      required: true,
    },
    requestId: { type: Number },
    requestPrice: { type: Number },
    regdate: { type: String },
    phaRequestPrice: { type: Number },
    isNotePatient: { type: Number },
    docId: { type: String },
    docFName: { type: String },
    docLName: { type: String },
    userId: { type: String },
    phaId: { type: String },
    month: { type: String },
    year: { type: String },
    prescDate: { type: String },
    patientAmount: { type: Number },
    custServiceType: { type: String },
    docspec: { type: String },
    custServiceTypeDesc: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

PharmacyFilledPrescriptionSchema.virtual("items", {
  ref: "PharmactFilledPrescriptionItem",
  localField: "_id",
  foreignField: "filledPrescription",
});

const PharmacyFilledPrescription = mongoose.model(
  "PharmacyFilledPrescription",
  PharmacyFilledPrescriptionSchema,
);

export default PharmacyFilledPrescription;
