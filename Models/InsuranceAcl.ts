import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInsurance } from "./Insurance";

export type Acl<T extends readonly string[], S> = MongoDoc & {
  name: string;
  owner?: S;
} & Partial<Record<T[number], boolean>>;

export const insuranceActions = [] as const;

export type InsuranceAction = (typeof insuranceActions)[number];

export type IInsuranceAcl = Acl<typeof insuranceActions, IInsurance>;

export const aclSchema = (actions: readonly string[], ownerKey: string) =>
  new mongoose.Schema<IInsuranceAcl, Model<IInsuranceAcl>>({
    name: { type: String, trim: true, default: "" },
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: ownerKey,
    },
    ...actions.reduce(
      (acc, action) => ({
        ...acc,
        [action]: { type: Boolean, default: false },
      }),
      {}
    ),
  });

const InsuranceAclSchema = aclSchema(insuranceActions, "Insurance");

const InsuranceAcl = mongoose.model("InsuranceAcl", InsuranceAclSchema);

export default InsuranceAcl;
