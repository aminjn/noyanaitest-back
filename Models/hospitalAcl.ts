import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IHospital } from "./Hospital";

// Sidebar-gating actions (2026-08), one per HospitalPabelSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/hospitalActions.tsx on noyanai-front.
export const hospitalActions = [
  "readArticles",
  // Licenses page (2026-09) — hospitalpanel/license, viewing the
  // BaseHospitalLicense catalog + this hospital's own HospitalProfileLicense.
  // Kept in sync with Components/Enums/actions/hospitalActions.tsx on
  // noyanai-front.
  "readLicenses",
] as const;

export type HospitalAction = (typeof hospitalActions)[number];

export type IHospitalAcl = Acl<typeof hospitalActions, IHospital>;

const HospitalAclSchema = aclSchema(hospitalActions, "Hospital");

const HospitalAcl = mongoose.model("HospitalAcl", HospitalAclSchema);

export default HospitalAcl;
