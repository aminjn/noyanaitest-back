import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { ITaminService } from "./TaminService";
import { ITaminDrugInstruction } from "./TaminDrugInstruction";
import { ITaminDrugAmount } from "./TaminDrugAmount";
import { ITaminDrugUsage } from "./TaminDrugUsage";

export interface IFavoriteDrug extends MongoDoc {
  doctor: IDoctorProfile;
  drug: ITaminService;
  instruction?: ITaminDrugInstruction;
  amount?: ITaminDrugAmount;
  usage?: ITaminDrugUsage;
  createdAt: Date;
  qty: number;
  description?: string;
}

const FavoriteDrugSchema = new mongoose.Schema<
  IFavoriteDrug,
  Model<IFavoriteDrug>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  drug: { type: mongoose.Schema.ObjectId, ref: "TaminService", required: true },
  instruction: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminDrugInstruction",
    required: true,
  },
  amount: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminDrugAmount",
    required: true,
  },
  usage: {
    type: mongoose.Schema.ObjectId,
    ref: "TaminDrugUsage",
    required: true,
  },
  qty: { type: Number, required: true },
  createdAt: { type: Date, default: () => new Date() },
  description: { type: String },
});

// FavoriteDrugSchema.index(
//   { doctor: 1, drug: 1, instruction: 1, amount: 1, usage: 1 },
//   { unique: true }
// );

const FavoriteDrug = mongoose.model("FavoriteDrug", FavoriteDrugSchema);

export default FavoriteDrug;
