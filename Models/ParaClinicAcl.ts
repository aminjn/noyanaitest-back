import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IParaClinic } from "./Paraclinic";

// Sidebar-gating actions (2026-08), one per ParaClinicSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/paraClinicActions.tsx on noyanai-front.
export const paraClinicActions = [
  // published reviews (2026-10, /<org>/review)
  "readReviews",
  // the finance page (2026-10, /<org>/finance)
  "readFinance",
  // bookkeeping in «حسابداری» (2026-10, Lib/business): manual vouchers,
  // accounts and quick income/expense entries; reading needs readFinance
  "manageAccounting",
  // «حقوق و دستمزد» (2026-10, /<org>/payroll): reading, and the employees,
  // the month's payslips and their payments
  "readPayroll",
  "managePayroll",
  // «ارتباط با بیماران و کمپین پیامکی» (2026-10, /<org>/crm): reading,
  // the contacts and follow-ups, and submitting a paid SMS campaign
  "readCrm",
  "manageCrm",
  "sendCampaigns",
  // the Moadian link and its electronic invoices (2026-10, /<org>/moadian)
  "readMoadian",
  "manageMoadian",
  // the stock, batches, suppliers and purchases in «انبار و خرید» (2026-10,
  // /<org>/inv): reading, and receiving, counting and paying
  "readInventory",
  "manageInventory",
  // Editing the public profile and location (2026-10); before this any
  // team member could, with no permission at all.
  "mutateProfile",
  "readTests",
  "readPrescriptions",
  "readArticles",
  "readTamin",
  // Incoming-orders page (2026-08) — paraClinicPanel/order, listing Order
  // docs that include this paraClinic's tests. Kept in sync with
  // Components/Enums/actions/paraClinicActions.tsx on noyanai-front.
  "readOrders",
  // Incoming-order detail page (2026-08) — paraClinicPanel/order/:nodeId,
  // fulfilling/cancelling this paraClinic's own line items within an order.
  // Kept in sync with Components/Enums/actions/paraClinicActions.tsx on
  // noyanai-front.
  "mutateOrders",
  // Licenses page (2026-09) — paraClinicPanel/license, viewing the
  // BaseParaClinicLicense catalog + this paraClinic's own
  // ParaClinicProfileLicense. Kept in sync with
  // Components/Enums/actions/paraClinicActions.tsx on noyanai-front.
  "readLicenses",
] as const;

export type ParaClinicAction = (typeof paraClinicActions)[number];

export type IParaClinicAcl = Acl<typeof paraClinicActions, IParaClinic>;

const ParaClinicAclSchema = aclSchema(paraClinicActions, "ParaClinic");

const ParaClinicAcl = mongoose.model("ParaClinicAcl", ParaClinicAclSchema);

export default ParaClinicAcl;
