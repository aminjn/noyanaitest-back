import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IDoctorProfile } from "./DoctorProfile";

export const doctorActions = [
  "readClinics",
  "leaveClinics",
  "joinClinic",
  "mutateJoinClinic",
  "clinicAddition",
  "readCalendar",
  "mutateCalendar",
  "readSettings",
  "mutateSettings",
  "readInsurance",
  "mutateInsurance",
  "insuranceAddition",
  "readPharmacy",
  "mutatePharmacy",
  "pharmacyAddition",
  "mutateProfile",
] as const;

export type DoctorAction = (typeof doctorActions)[number];

export type IDoctorAcl = Acl<typeof doctorActions, IDoctorProfile>;

const DoctorAclSchema = aclSchema(doctorActions, "DoctorProfile");

const DoctorAcl = mongoose.model("DoctorAcl", DoctorAclSchema);

export default DoctorAcl;
