import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IUserIdentity } from "./UserIdentity";
import { ITaminService } from "./TaminService";
import { ITaminDrugUsage } from "./TaminDrugUsage";
import { ITaminDrugInstruction } from "./TaminDrugInstruction";
import { ITaminDrugAmount } from "./TaminDrugAmount";
import { ITaminPrescription } from "./TaminPrescription";

export interface IPrescription extends MongoDoc {
  author: IDoctorProfile;
  patient: IUserIdentity;
  items: {
    item: ITaminService;
    usage: ITaminDrugUsage;
    instruction: ITaminDrugInstruction;
    amount: ITaminDrugAmount;
    qty: number;
    description?: string;
  }[];
  createdAt: Date;
  taminStatus?: ITaminPrescription | null;
}

const PrescriptionSchema = new mongoose.Schema<
  IPrescription,
  Model<IPrescription>
>(
  {
    author: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    patient: {
      type: mongoose.Schema.ObjectId,
      ref: "UserIdentity",
      required: true,
    },
    items: {
      type: [
        new mongoose.Schema({
          item: {
            type: mongoose.Schema.ObjectId,
            required: true,
            ref: "TaminService",
          },
          usage: {
            type: mongoose.Schema.ObjectId,
            required: true,
            ref: "TaminDrugUsage",
          },
          instruction: {
            type: mongoose.Schema.ObjectId,
            required: true,
            ref: "TaminDrugInstruction",
          },
          amount: {
            type: mongoose.Schema.ObjectId,
            required: true,
            ref: "TaminDrugAmount",
          },
          qty: { type: Number, required: true },
          description: { type: String },
        }),
      ],
      required: true,
    },
    createdAt: { type: Date, default: () => new Date() },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

PrescriptionSchema.virtual("taminStatus", {
  ref: "TaminPrescription",
  localField: "_id",
  foreignField: "prescription",
  justOne: true,
});

const Prescription = mongoose.model("Prescription", PrescriptionSchema);

export default Prescription;
