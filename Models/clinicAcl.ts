import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IClinic } from "./Clinic";

export const clinicActions = [] as const;

export type ClinicAction = (typeof clinicActions)[number];

export type IClinicAcl = Acl<typeof clinicActions, IClinic>;

const ClinicAclSchema = aclSchema(clinicActions, "Clinic");

const ClinicAcl = mongoose.model("ClinicAcl", ClinicAclSchema);

export default ClinicAcl;
