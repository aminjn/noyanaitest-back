import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInsurance } from "./Insurance";

export type Acl<T extends readonly string[], S> = MongoDoc & {
  name: string;
  owner?: S;
} & Partial<Record<T[number], boolean>>;

// Sidebar-gating actions (2026-08), one per InsurancePanelSidebar nav item
// that isn't a baseline (always-visible) page or the secretary-management
// item itself (owner-only by design). Kept in sync with
// Components/Enums/actions/insuranceActions.tsx on noyanai-front.
export const insuranceActions = [
  // plans and network (2026-10, /insurance/plan, /insurance/network)
  "managePlans",
  "readNetwork",
  // the finance page (2026-10, /<org>/finance)
  "readFinance",
  // Editing the public profile and location (2026-10); before this any
  // team member could, with no permission at all.
  "mutateProfile",
  "readArticles",
  // Licenses page (2026-09) — insurancepanel/license. Kept in sync with
  // Components/Enums/actions/insuranceActions.tsx on noyanai-front.
  "readLicenses",
] as const;

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
