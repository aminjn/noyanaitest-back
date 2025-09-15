import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IInsurance extends MongoDoc {
  user?: IUser;
  name?: string;
  active: boolean;
  order: number;
}

const InsuranceSchema = new mongoose.Schema<IInsurance, Model<IInsurance>>({
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

const Insurance = mongoose.model("Insurance", InsuranceSchema);

export default Insurance;
