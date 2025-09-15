import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IPharmacy } from "./Pharmacy";

export const pharmacyActions = [] as const;

export type PharmacyAction = (typeof pharmacyActions)[number];

export type IPharmacyAcl = Acl<typeof pharmacyActions, IPharmacy>;

const PharmacyAclSchema = aclSchema(pharmacyActions, "Pharmacy");

const PharmacyAcl = mongoose.model("PharmacyAcl", PharmacyAclSchema);

export default PharmacyAcl;
