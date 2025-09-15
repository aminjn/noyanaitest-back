import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IInsurance } from "./Insurance";
import { IInsuranceAcl } from "./InsuranceAcl";

export interface IInsuranceSecretary extends MongoDoc {
  insurance: IInsurance;
  secretary: IUser;
  acl?: IInsuranceAcl;
  displayName?: string;
}

const InsuranceSecretarySchema = new mongoose.Schema<
  IInsuranceSecretary,
  Model<IInsuranceSecretary>
>({
  insurance: {
    type: mongoose.Schema.ObjectId,
    ref: "Insurance",
    required: true,
  },
  secretary: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  acl: {
    type: mongoose.Schema.ObjectId,
    ref: "InsuranceAcl",
  },
  displayName: { type: String },
});

InsuranceSecretarySchema.index(
  { insurance: 1, secretary: 1 },
  { unique: true }
);

const InsuranceSecretary = mongoose.model(
  "InsuranceSecretary",
  InsuranceSecretarySchema
);

export default InsuranceSecretary;
