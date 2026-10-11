import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { ITaminPrescriptionType } from "../TaminPrescriptionType";
import { IPrescription2 } from "./Prescription2";
import { ITaminServiceType } from "../TaminServiceType";

export interface ITaminPrescription2 extends MongoDoc {
  prescType: ITaminPrescriptionType;
  serviceType: ITaminServiceType;
  prescription: IPrescription2;
  tracking: string;
  taminId: string;
  createdAt: Date;
  // Tamin allows a single edit per prescription (guide section 7).
  editedAt?: Date;
}

const TaminPrescription2Schema = new mongoose.Schema<
  ITaminPrescription2,
  Model<ITaminPrescription2>
>({
  prescType: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminPrescriptionType",
    required: true,
  },
  serviceType: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminServiceType",
    required: true,
  },
  prescription: {
    type: mongoose.Schema.ObjectId,
    ref: "Prescription",
    required: true,
  },
  tracking: { type: String },
  taminId: { type: String },
  createdAt: { type: Date, default: () => new Date() },
  editedAt: { type: Date },
});

const TaminPrescription2 = mongoose.model(
  "TaminPrescription2",
  TaminPrescription2Schema,
);

export default TaminPrescription2;
