import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IClinic } from "./Clinic";

// Sidebar-gating actions (2026-08), one per ClinicPabelSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/clinicActions.tsx on noyanai-front.
export const clinicActions = [
  // published reviews (2026-10, /<org>/review)
  "readReviews",
  // the finance page (2026-10, /<org>/finance)
  "readFinance",
  // the centre agenda (2026-10, /<center>/reservation)
  "readReservations",
  // Editing the public profile and location (2026-10); before this any
  // team member could, with no permission at all.
  "mutateProfile",
  "readPrescriptions",
  "readArticles",
  // Licenses page (2026-09) — clinicpanel/license, viewing the
  // BaseClinicLicense catalog + this clinic's own ClinicProfileLicense.
  // Kept in sync with Components/Enums/actions/clinicActions.tsx on
  // noyanai-front.
  "readLicenses",
] as const;

export type ClinicAction = (typeof clinicActions)[number];

export type IClinicAcl = Acl<typeof clinicActions, IClinic>;

const ClinicAclSchema = aclSchema(clinicActions, "Clinic");

const ClinicAcl = mongoose.model("ClinicAcl", ClinicAclSchema);

export default ClinicAcl;
