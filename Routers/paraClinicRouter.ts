import { businessRouter } from "./businessRoutes";
import { payrollRouter } from "./payrollRoutes";
import { crmRouter } from "./crmRoutes";
import { kartablRouter } from "./kartablRoutes";
import { moadianRouter } from "./moadianRoutes";
import { inventoryRouter } from "./inventoryRoutes";
import { ownerOfReq } from "../Controllers/businessController";
import express from "express";
import * as orgFinanceController from "../Controllers/orgFinanceController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as paraClinicController from "../Controllers/paraClinicController";
import * as aclController from "../Controllers/aclController";
import * as autoController from "../Controllers/autoController";
import * as featureGateController from "../Controllers/featureGateController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

// Note on paraClinicController.requireLicenseModule(...) below (2026-09):
// it's chained right after every aclController.useParaClinic(...) call so
// req.paraClinic is already set, mirroring doctorRouter.ts's own comment.
// Two deliberate omissions:
//  - "/" (getMyParaClinicProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the paraClinic is, same
//    "always visible, never gated" treatment ParaClinicSidebar gives the
//    "profile" link itself (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a paraClinic with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useParaClinic(...) at all, since it runs
// before a ParaClinic profile even exists, so there's no req.paraClinic yet
// to check a license against - left untouched.

router
  .route("/")
  .get(
    aclController.useParaClinic(),
    paraClinicController.getMyParaClinicProfile,
  )
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "paraClinic" }),
    paraClinicController.becomeAParaClinic,
  );

router.route("/request").get(paraClinicController.getMyBecomeParaClinicRequest);

router
  .route("/profile")
  .post(
    aclController.useParaClinic("mutateProfile"),
    paraClinicController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "paraClinic" }),
    autoController.mutateCompoundFields(["tags", "insurances", "location"]),
    paraClinicController.updateMyParaClinicProfile,
  );

router
  .route("/tamin")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getPrescs,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.precheckPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.submitPrescription,
  );

router
  .route("/taminn")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.deletePrescription,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.registerDiagnosis,
  );

router
  .route("/icid")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getIcids,
  );

router
  .route("/test")
  .get(
    aclController.useParaClinic("readTests"),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.getAvailableTests,
  );

router
  .route("/order/stats")
  .get(
    aclController.useParaClinic("readOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    paraClinicController.getMyOrderStats,
  );

router
  .route("/order")
  .get(
    aclController.useParaClinic("readOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    paraClinicController.getMyIncomingOrders,
  );

router
  .route("/order/:nodeId/result/:lineId")
  .post(
    aclController.useParaClinic("mutateOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    uploadController.upload.array("files", 5),
    paraClinicController.uploadTestResult,
  );

router
  .route("/order/:nodeId")
  .get(
    aclController.useParaClinic("readOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    paraClinicController.getMyIncomingOrder,
  )
  .patch(
    aclController.useParaClinic("mutateOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    paraClinicController.mutateIncomingOrderItem,
  );

router
  .route("/myTest")
  .get(
    aclController.useParaClinic("readTests"),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.getMyTests,
  )
  .post(
    aclController.useParaClinic("readTests"),
    paraClinicController.requireLicenseModule("tests"),
    uploadController.upload.none(),
    paraClinicController.addMyTest,
  );

router
  .route("/myTest/:nodeId")
  .post(
    aclController.useParaClinic("readTests"),
    paraClinicController.requireLicenseModule("tests"),
    uploadController.upload.none(),
    paraClinicController.editMyTest,
  )
  .put(
    aclController.useParaClinic("readTests"),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.removeMyTest,
  );

router
  .route("/tamin/physio")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.registerPhysioSession,
  );

router
  .route("/tamin/session")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.registerPhysioSession,
  );

router
  .route("/license")
  .get(
    aclController.useParaClinic("readLicenses"),
    paraClinicController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(
    aclController.useParaClinic(),
    paraClinicController.getMyLicenseModules,
  );

// "See all plans" page (2026-09) - every isActive BaseParaClinicLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useParaClinic("readLicenses"),
    paraClinicController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the paraClinic's own currently
// assigned ParaClinicProfileLicense, gated like "/license" above.
// Registered before "/license/:nodeId" so "current" isn't swallowed as a
// nodeId.
router
  .route("/license/current")
  .get(
    aclController.useParaClinic("readLicenses"),
    paraClinicController.getMyCurrentLicense,
  );

// Purchase route (2026-09) - deliberately not gated by a specific action
// like "readLicenses" - this spends the paraClinic's own wallet balance, so
// a generic aclController.useParaClinic() presence check is enough, same as
// pharmacyRouter.ts's own purchase route. Not gated by requireLicenseModule
// either - see the comment block at the top of this file. The GET on the
// same path (a single plan's own detail page) is gated like "/license"
// above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useParaClinic("readLicenses"),
    paraClinicController.getLicenseById,
  )
  .post(aclController.useParaClinic(true), paraClinicController.purchaseLicense);

// wallet, income, license spend and transactions (Lib/orgFinance.ts)
router
  .route("/finance")
  .get(aclController.useParaClinic("readFinance"), orgFinanceController.getMyOrgFinance("paraClinic"));

// published reviews and the average score (read-only)
router
  .route("/review")
  .get(aclController.useParaClinic("readReviews"), orgFinanceController.getMyOrgReviews("paraClinic"));
// the owner answers a published review publicly, once
router
  .route("/review/:nodeId/reply")
  .post(aclController.useParaClinic(true), uploadController.upload.none(), orgFinanceController.replyToMyOrgReview("paraClinic"));

// Noyan Business accounting (2026-10, Lib/business): the paraClinic's own books.
// Read with readFinance, write with manageAccounting; the plan's
// "accounting" module opens it.
router.use(
  "/biz",
  businessRouter({
    ownerOf: ownerOfReq("paraClinic"),
    read: [aclController.useParaClinic("readFinance"), paraClinicController.requireLicenseModule("accounting")],
    write: [aclController.useParaClinic("manageAccounting"), paraClinicController.requireLicenseModule("accounting")],
    approve: [aclController.useParaClinic("approveVouchers"), paraClinicController.requireLicenseModule("accounting")],
  }),
);

// Noyan Business inventory and purchasing (2026-10, Lib/business/inventory.ts
// and purchase.ts): stock, batches, suppliers and purchases. Read with
// readInventory, write with manageInventory; the plan's "inventory" module
// opens it.
router.use(
  "/inv",
  inventoryRouter({
    ownerOf: ownerOfReq("paraClinic"),
    read: [aclController.useParaClinic("readInventory"), paraClinicController.requireLicenseModule("inventory")],
    write: [aclController.useParaClinic("manageInventory"), paraClinicController.requireLicenseModule("inventory")],
  }),
);

// Noyan Business payroll (2026-10, Lib/business/payroll.ts): employees, the
// month's payslips with insurance and tax, and their payments. Read with
// readPayroll, write with managePayroll; the plan's "payroll" module opens it.
router.use(
  "/payroll",
  payrollRouter({
    ownerOf: ownerOfReq("paraClinic"),
    read: [aclController.useParaClinic("readPayroll"), paraClinicController.requireLicenseModule("payroll")],
    write: [aclController.useParaClinic("managePayroll"), paraClinicController.requireLicenseModule("payroll")],
  }),
);

// Noyan Business CRM and SMS campaigns (2026-10, Lib/business/crm.ts and
// campaign.ts): patients and customers, follow-ups, campaigns. Read with
// readCrm, write with manageCrm, submit a campaign with sendCampaigns; the
// plan's "crm" module opens it.
router.use(
  "/crm",
  crmRouter({
    ownerOf: ownerOfReq("paraClinic"),
    read: [aclController.useParaClinic("readCrm"), paraClinicController.requireLicenseModule("crm")],
    write: [aclController.useParaClinic("manageCrm"), paraClinicController.requireLicenseModule("crm")],
    send: [aclController.useParaClinic("sendCampaigns"), paraClinicController.requireLicenseModule("crm")],
  }),
);

// the panel's one approval queue («کارتابل», 2026-10): finance requests,
// sales approvals, returns and workflow steps (Routers/kartablRoutes.ts)
router.use("/kartabl", kartablRouter({ ownerOf: ownerOfReq("paraClinic"), member: aclController.useParaClinic() }));

// Noyan Business Moadian (2026-10, Lib/moadian): the electronic invoice
// link (key, memory id, item ids) and the invoices made from paid visits
// and sales. Read with readMoadian, change with manageMoadian; the plan's
// "moadian" module opens it.
router.use(
  "/moadian",
  moadianRouter({
    ownerOf: ownerOfReq("paraClinic"),
    read: [aclController.useParaClinic("readMoadian"), paraClinicController.requireLicenseModule("moadian")],
    write: [aclController.useParaClinic("manageMoadian"), paraClinicController.requireLicenseModule("moadian")],
  }),
);

export default router;
