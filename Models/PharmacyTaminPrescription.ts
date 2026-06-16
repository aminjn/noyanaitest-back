import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";

export interface IPharmacyTaminPrescription extends MongoDoc {
  pharmacy: IPharmacy;
  headeprscid: number;
  prescdate: string;
  docid: string;
  docspec: string;
  doctorFullName: string;
  patientfirstname: string;
  patientlastname: string;
  custname: null;
  comments: string;
  refeR_REASON: null;
  electronicflag: string;
  clinicdoc: string;
  presctime: string;
  speccode: string;
}

const PharmacyTaminPrescriptionSchema = new mongoose.Schema<
  IPharmacyTaminPrescription,
  Model<IPharmacyTaminPrescription>
>(
  {
    pharmacy: {
      type: mongoose.Schema.ObjectId,
      ref: "Pharmacy",
      required: true,
    },
    headeprscid: { type: Number },
    prescdate: { type: String },
    docid: { type: String },
    docspec: { type: String },
    doctorFullName: { type: String },
    patientfirstname: { type: String },
    patientlastname: { type: String },
    custname: { type: String },
    comments: { type: String },
    refeR_REASON: { type: String },
    electronicflag: { type: String },
    clinicdoc: { type: String },
    presctime: { type: String },
    speccode: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

PharmacyTaminPrescriptionSchema.virtual("items", {
  ref: "PharmacyTaminPrescriptionItem",
  localField: "_id",
  foreignField: "prescription",
});

PharmacyTaminPrescriptionSchema.index(
  { pharmacy: 1, headeprscid: 1 },
  { unique: true },
);

const PharmacyTaminPrescription = mongoose.model(
  "PharmacyTaminPrescription",
  PharmacyTaminPrescriptionSchema,
);

export default PharmacyTaminPrescription;
