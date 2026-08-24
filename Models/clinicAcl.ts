import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IClinic } from "./Clinic";

// Sidebar-gating actions (2026-08), one per ClinicPabelSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/clinicActions.tsx on noyanai-front.
export const clinicActions = ["readPrescriptions", "readArticles"] as const;

export type ClinicAction = (typeof clinicActions)[number];

export type IClinicAcl = Acl<typeof clinicActions, IClinic>;

const ClinicAclSchema = aclSchema(clinicActions, "Clinic");

const ClinicAcl = mongoose.model("ClinicAcl", ClinicAclSchema);

export default ClinicAcl;
