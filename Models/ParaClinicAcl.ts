import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IParaClinic } from "./Paraclinic";

// Sidebar-gating actions (2026-08), one per ParaClinicSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/paraClinicActions.tsx on noyanai-front.
export const paraClinicActions = [
  "readTests",
  "readPrescriptions",
  "readArticles",
  "readTamin",
  // Incoming-orders page (2026-08) — paraClinicPanel/order, listing Order
  // docs that include this paraClinic's tests. Kept in sync with
  // Components/Enums/actions/paraClinicActions.tsx on noyanai-front.
  "readOrders",
] as const;

export type ParaClinicAction = (typeof paraClinicActions)[number];

export type IParaClinicAcl = Acl<typeof paraClinicActions, IParaClinic>;

const ParaClinicAclSchema = aclSchema(paraClinicActions, "ParaClinic");

const ParaClinicAcl = mongoose.model("ParaClinicAcl", ParaClinicAclSchema);

export default ParaClinicAcl;
