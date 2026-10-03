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
