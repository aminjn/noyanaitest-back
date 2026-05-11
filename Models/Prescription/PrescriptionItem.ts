import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IPrescription2 } from "./Prescription2";
import { ITaminService } from "../TaminService";
import { ITaminDrugAmount } from "../TaminDrugAmount";
import { ITaminDrugInstruction } from "../TaminDrugInstruction";

export interface IPrescriptionItem extends MongoDoc {
  prescription: IPrescription2;
  service: ITaminService;
  qty: number;
  timesADay?: ITaminDrugAmount;
  dose?: string;
  repeat?: string;
  dateDo?: Date;
  drugInstruction?: ITaminDrugInstruction;
}

const PrescriptionItemSchema = new mongoose.Schema<
  IPrescriptionItem,
  Model<IPrescriptionItem>
>({
  prescription: {
    type: mongoose.Schema.ObjectId,
    ref: "Prescription2",
    required: true,
  },
  service: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminService",
    required: true,
  },
  qty: { type: Number, required: true },
  timesADay: { type: mongoose.Schema.ObjectId, ref: "TaminDrugAmount" },
  dose: { type: String },
  repeat: { type: String },
  dateDo: { type: Date },
  drugInstruction: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminDrugInstruction",
  },
});

const PrescriptionItem = mongoose.model(
  "PrescriptionItem",
  PrescriptionItemSchema,
);

export default PrescriptionItem;
