import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IHospital } from "./Hospital";

// Sidebar-gating actions (2026-08), one per HospitalPabelSidebar nav item that
// isn't a baseline (always-visible) page or the secretary-management item
// itself (owner-only by design). Kept in sync with
// Components/Enums/actions/hospitalActions.tsx on noyanai-front.
export const hospitalActions = [
  // published reviews (2026-10, /<org>/review)
  "readReviews",
  // the finance page (2026-10, /<org>/finance)
  "readFinance",
  // bookkeeping in «حسابداری» (2026-10, Lib/business): manual vouchers,
  // accounts and quick income/expense entries; reading needs readFinance
  "manageAccounting",
  // finalizing, reverting and deleting final vouchers and deciding finance
  // requests (2026-10, Nexxa journal.post / journal.delete)
  "approveVouchers",
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
