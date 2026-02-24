import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPrescription } from "./Prescription";

export interface ITaminPrescription extends MongoDoc {
  prescription: IPrescription;
  tracking?: string;
  taminId?: string;
  submittedAt: Date;
  labTracking?: string;
  labTaminId?: string;
}

const TaminPrescriptionSchema = new mongoose.Schema<
  ITaminPrescription,
  Model<ITaminPrescription>
>({
  prescription: {
    type: mongoose.Schema.ObjectId,
    ref: "Prescription",
    required: true,
    unique: true,
  },
  tracking: { type: String },
  taminId: { type: String },
  labTracking: { type: String },
  labTaminId: { type: String },
  submittedAt: { type: Date, default: () => new Date() },
});

const TaminPrescription = mongoose.model(
  "TaminPrescription",
  TaminPrescriptionSchema,
);

export default TaminPrescription;
