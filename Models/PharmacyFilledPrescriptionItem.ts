import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacyFilledPrescription } from "./PharmacyFilledPrescription";

export interface IPharmacyFilledPrescriptionItem extends MongoDoc {
  filledPrescription: IPharmacyFilledPrescription;
  drugCode: string;
  drugName: string;
  drugCount: number;
  itemPrice: number;
  franshiz: number;
  phaItemPrice: number;
  timesaday: string;
  dose: string;
  is_Note_Patient: number;
  subsidyprice: number;
  patient_Price: number;
  support_Specialpatient: number;
  sumPrice: number;
  sumIsNotePatient: number;
}

const PharmacyFilledPrescriptionItemSchema = new mongoose.Schema<
  IPharmacyFilledPrescriptionItem,
  Model<IPharmacyFilledPrescriptionItem>
>({
  filledPrescription: {
    type: mongoose.Schema.ObjectId,
    ref: "PharmacyFilledPrescription",
    required: true,
  },
  drugCode: { type: String },
  drugName: { type: String },
  drugCount: { type: Number },
  itemPrice: { type: Number },
  franshiz: { type: Number },
  phaItemPrice: { type: Number },
  timesaday: { type: String },
  dose: { type: String },
  is_Note_Patient: { type: Number },
  subsidyprice: { type: Number },
  patient_Price: { type: Number },
  support_Specialpatient: { type: Number },
  sumPrice: { type: Number },
  sumIsNotePatient: { type: Number },
});

const PharmacyFilledPrescriptionItem = mongoose.model(
  "PharmacyFilledPrescriptionItem",
  PharmacyFilledPrescriptionItemSchema,
);

export default PharmacyFilledPrescriptionItem;
