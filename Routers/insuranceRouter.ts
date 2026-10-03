import { businessRouter } from "./businessRoutes";
import { payrollRouter } from "./payrollRoutes";
import { ownerOfReq } from "../Controllers/businessController";
import express from "express";
import * as orgFinanceController from "../Controllers/orgFinanceController";
import * as insurerController from "../Controllers/insurerController";
import * as authController from "../Controllers/authController";
import * as insuranceController from "../Controllers/InsuracneController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

// Note on insuranceController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useInsurance(...) call so
// req.insurance is already set, mirroring hospitalRouter.ts's own comment.
// Two deliberate omissions:
//  - "/" (getMyInsuranceProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the insurance is, same
//    "always visible, never gated" treatment InsurancePanelSidebar itself
//    gives the "profile" link (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: an insurance with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useInsurance(...) at all, since it runs
// before an Insurance profile even exists, so there's no req.insurance yet
// to check a license against - left untouched.

router
  .route("/")
  .get(aclController.useInsurance(), insuranceController.getMyInsuranceProfile)
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "insurance" }),
    insuranceController.becomeAInsurance,
  );

router.route("/request").get(insuranceController.getMyBecomeInsuranceRequest);

router
  .route("/profile")
  .post(
    aclController.useInsurance("mutateProfile"),
    insuranceController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "insurance" }),
    autoController.mutateCompoundFields([
      "tags",
      "location",
      "coverages",
      "advantages",
    ]),
    insuranceController.updateMyInsuranceProfile,
  );

router
  .route("/license")
  .get(
    aclController.useInsurance("readLicenses"),
    insuranceController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.useInsurance(), insuranceController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseInsuranceLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useInsurance("readLicenses"),
    insuranceController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the insurance's own currently
// assigned InsuranceProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.useInsurance("readLicenses"),
    insuranceController.getMyCurrentLicense,
  );

// Purchasing a license isn't gated by requireLicenseModule or a specific
// action like "readLicenses" - this spends the insurance's own wallet
// balance, so a generic aclController.useInsurance() presence check is
// enough, same as hospitalRouter.ts's own purchase route. Not gated by
// requireLicenseModule for the same circularity reason as "/license" above.
// The GET on the same path (a single plan's own detail page) is gated like
// "/license" above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useInsurance("readLicenses"),
    insuranceController.getLicenseById,
  )
  .post(aclController.useInsurance(true), insuranceController.purchaseLicense);

// wallet, income, license spend and transactions (Lib/orgFinance.ts)
router
  .route("/finance")
  .get(aclController.useInsurance("readFinance"), orgFinanceController.getMyOrgFinance("insurance"));

// the insurer's own plans and its provider network (2026-10)
router
  .route("/plan")
  .get(aclController.useInsurance("managePlans"), insurerController.getMyPlans)
  .post(aclController.useInsurance("managePlans"), insurerController.createMyPlan);
router
  .route("/plan/:nodeId")
  .patch(aclController.useInsurance("managePlans"), insurerController.editMyPlan)
  .delete(aclController.useInsurance("managePlans"), insurerController.removeMyPlan);
router
  .route("/network")
  .get(aclController.useInsurance("readNetwork"), insurerController.getMyNetwork);

// published reviews and the average score (read-only)
router
  .route("/review")
  .get(aclController.useInsurance("readReviews"), orgFinanceController.getMyOrgReviews("insurance"));

// Noyan Business accounting (2026-10, Lib/business): the insurance's own books.
// Read with readFinance, write with manageAccounting; the plan's
// "accounting" module opens it.
router.use(
  "/biz",
  businessRouter({
    ownerOf: ownerOfReq("insurance"),
    read: [aclController.useInsurance("readFinance"), insuranceController.requireLicenseModule("accounting")],
    write: [aclController.useInsurance("manageAccounting"), insuranceController.requireLicenseModule("accounting")],
  }),
);

// Noyan Business payroll (2026-10, Lib/business/payroll.ts): employees, the
// month's payslips with insurance and tax, and their payments. Read with
// readPayroll, write with managePayroll; the plan's "payroll" module opens it.
router.use(
  "/payroll",
  payrollRouter({
    ownerOf: ownerOfReq("insurance"),
    read: [aclController.useInsurance("readPayroll"), insuranceController.requireLicenseModule("payroll")],
    write: [aclController.useInsurance("managePayroll"), insuranceController.requireLicenseModule("payroll")],
  }),
);

export default router;
