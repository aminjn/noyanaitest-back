import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IPharmacy } from "./Pharmacy";

// Sidebar-gating actions (2026-08), one per PharmacyPanelSidebar nav item
// that isn't a baseline (always-visible) page or the secretary-management
// item itself (owner-only by design). Kept in sync with
// Components/Enums/actions/pharmacyActions.tsx on noyanai-front.
export const pharmacyActions = [
  // buyers' published reviews (2026-10, /pharmacy/review)
  "readReviews",
  // Editing the public profile and location (2026-10); before this any
  // team member could, with no permission at all.
  "mutateProfile",
  "readProducts",
  "readProductPackages",
  "readPrescriptions",
  "readArticles",
  "readTamin",
  // Incoming-orders page (2026-08) — pharmacypanel/order, listing Order
  // docs that include this pharmacy's products/productPackages. Kept in
  // sync with Components/Enums/actions/pharmacyActions.tsx on noyanai-front.
  "readOrders",
  // Incoming-order detail page (2026-08) — pharmacypanel/order/:nodeId,
  // fulfilling/cancelling this pharmacy's own line items within an order.
  // Kept in sync with Components/Enums/actions/pharmacyActions.tsx on
  // noyanai-front.
  "mutateOrders",
  // Dispatching/checking a Snapp Box courier for an order's delivery
  // (2026-09) — pharmacypanel/order/:nodeId's delivery action. Kept in sync
  // with Components/Enums/actions/pharmacyActions.tsx on noyanai-front.
  "dispatchDelivery",
  // Licenses page (2026-09) — pharmacypanel/license, viewing the
  // BasePharmacyLicense catalog + this pharmacy's own PharmacyProfileLicense.
  // Kept in sync with Components/Enums/actions/pharmacyActions.tsx on
  // noyanai-front.
  "readLicenses",
  // Finance page (2026-09) - pharmacypanel/finance: balance, sales payouts,
  // pending orders and license spend. Kept in sync with
  // Components/Enums/actions/pharmacyActions.tsx on noyanai-front.
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
] as const;

export type PharmacyAction = (typeof pharmacyActions)[number];

export type IPharmacyAcl = Acl<typeof pharmacyActions, IPharmacy>;

const PharmacyAclSchema = aclSchema(pharmacyActions, "Pharmacy");

const PharmacyAcl = mongoose.model("PharmacyAcl", PharmacyAclSchema);

export default PharmacyAcl;
