import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacyTaminPrescription } from "./PharmacyTaminPrescription";

export interface IPharmacyTaminPrescriptionItem extends MongoDoc {
  prescription: IPharmacyTaminPrescription;
  detailId: number;
  drugCode: string;
  drugName: string;
  drugForm: string;
  insuranceStatus: string;
  requiresBarcodeInquiry: string;
  hospitalDrug: string;
  maxAge: string;
  prescribedCount: string;
  remainingCount: string;
  drugInstruction: string;
}

const PharmacyTaminPrescriptionItemSchema = new mongoose.Schema<
  IPharmacyTaminPrescriptionItem,
  Model<IPharmacyTaminPrescriptionItem>
>({
  prescription: {
    type: mongoose.Schema.ObjectId,
    ref: "PharmacyTaminPrescription",
    required: true,
  },
  detailId: { type: Number },
  drugCode: { type: String },
  drugName: { type: String },
  drugForm: { type: String },
  insuranceStatus: { type: String },
  requiresBarcodeInquiry: { type: String },
  hospitalDrug: { type: String },
  maxAge: { type: String },
  prescribedCount: { type: String },
  remainingCount: { type: String },
  drugInstruction: { type: String },
});

PharmacyTaminPrescriptionItemSchema.index(
  { prescription: 1, detailId: 1 },
  { unique: true },
);

const PharmacyTaminPrescriptionItem = mongoose.model(
  "PharmacyTaminPrescriptionItem",
  PharmacyTaminPrescriptionItemSchema,
);

export default PharmacyTaminPrescriptionItem;
