import express from "express";
import * as orgFinanceController from "../Controllers/orgFinanceController";
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

export default router;
