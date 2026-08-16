import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInsurance } from "./Insurance";

export interface IInsurancePlan extends MongoDoc {
  insurance: IInsurance;
  name?: string;
  isActive: boolean;
  order: number;
  price: number;
  features: string[];
  isPopular: boolean;
}

const InsurancePlanSchema = new mongoose.Schema<
  IInsurancePlan,
  Model<IInsurancePlan>
>({
  insurance: {
    type: mongoose.Schema.ObjectId,
    ref: "Insurance",
    required: true,
  },
  name: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  price: { type: Number, default: 0 },
  features: { type: [String], default: [] },
  isPopular: { type: Boolean, default: false },
});

const InsurancePlan = mongoose.model("InsurancePlan", InsurancePlanSchema);

export default InsurancePlan;
