import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IPharmacy extends MongoDoc {
  user?: IUser;
  name?: string;
  order: number;
  active: boolean;
}

const PharmacySchema = new mongoose.Schema<IPharmacy, Model<IPharmacy>>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    unique: true,
    sparse: true,
  },
  name: { type: String },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
});

const Pharmacy = mongoose.model("Pharmacy", PharmacySchema);

export default Pharmacy;
