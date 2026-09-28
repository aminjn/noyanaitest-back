import mongoose, { Model } from "mongoose";
import { Acl, aclSchema } from "./InsuranceAcl";
import { IPharmacy } from "./Pharmacy";

// Sidebar-gating actions (2026-08), one per PharmacyPanelSidebar nav item
// that isn't a baseline (always-visible) page or the secretary-management
// item itself (owner-only by design). Kept in sync with
// Components/Enums/actions/pharmacyActions.tsx on noyanai-front.
export const pharmacyActions = [
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
] as const;

export type PharmacyAction = (typeof pharmacyActions)[number];

export type IPharmacyAcl = Acl<typeof pharmacyActions, IPharmacy>;

const PharmacyAclSchema = aclSchema(pharmacyActions, "Pharmacy");

const PharmacyAcl = mongoose.model("PharmacyAcl", PharmacyAclSchema);

export default PharmacyAcl;
