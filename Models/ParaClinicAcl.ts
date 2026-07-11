import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IParaClinic } from "./Paraclinic";

export const paraClinicActions = [] as const;

export type ParaClinicAction = (typeof paraClinicActions)[number];

export type IParaClinicAcl = Acl<typeof paraClinicActions, IParaClinic>;

const ParaClinicAclSchema = aclSchema(paraClinicActions, "ParaClinic");

const ParaClinicAcl = mongoose.model("ParaClinicAcl", ParaClinicAclSchema);

export default ParaClinicAcl;
