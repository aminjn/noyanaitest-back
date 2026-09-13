import express from "express";

import * as authController from "../Controllers/authController";
import * as pharmacyController from "../Controllers/pharmacyController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import * as featureGateController from "../Controllers/featureGateController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

// Note on pharmacyController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.usePharmacy(...) call so
// req.pharmacy is already set, mirroring doctorRouter.ts's own comment.
// Two deliberate omissions:
//  - "/" (getMyPharmacyProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the pharmacy is, same
//    "always visible, never gated" treatment PharmacyPanelSidebar gives the
//    "profile" link itself (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a pharmacy with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.usePharmacy(...) at all, since it runs
// before a Pharmacy profile even exists, so there's no req.pharmacy yet to
// check a license against - left untouched.

router
  .route("/")
  .get(aclController.usePharmacy(), pharmacyController.getMyPharmacyProfile)
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "pharmacy" }),
    pharmacyController.becomeAPharmacy,
  );

router.route("/request").get(pharmacyController.getMyBecomePharmacyRequest);

router
  .route("/profile")
  .post(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "pharmacy" }),
    autoController.mutateCompoundFields(["location"]),
    pharmacyController.updateMyPharmacyProfile,
  );

router
  .route("/prescription")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    pharmacyController.getCachedPrescriptions,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    pharmacyController.getPatientPrescriptions,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    pharmacyController.fillPrescription,
  );

router
  .route("/filledPrescription")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    pharmacyController.getFilledPrescriptions,
  );

router
  .route("/filledPrescription/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    pharmacyController.getFilledPrescription,
  );

router
  .route("/drug")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    pharmacyController.getDrugEquiv,
  );

router
  .route("/product")
  .get(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("products"),
    pharmacyController.getAvailableProducts,
  );

router
  .route("/myProduct")
  .get(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("products"),
    pharmacyController.getMyProducts,
  )
  .post(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("products"),
    uploadController.upload.none(),
    pharmacyController.addMyProduct,
  );

router
  .route("/myProduct/:nodeId")
  .post(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("products"),
    uploadController.upload.none(),
    pharmacyController.editMyProduct,
  )
  .put(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("products"),
    pharmacyController.removeMyProduct,
  );

router
  .route("/productPackageCategory")
  .get(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("productPackages"),
    pharmacyController.getProductPackageCategories,
  );

router
  .route("/productPackage")
  .get(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("productPackages"),
    pharmacyController.getMyProductPackages,
  )
  .post(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("productPackages"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "productPackage" }),
    autoController.mutateCompoundFields(["products"]),
    pharmacyController.createMyProductPackage,
  );

router
  .route("/productPackage/:nodeId")
  .post(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("productPackages"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "productPackage" }),
    autoController.mutateCompoundFields(["products"]),
    pharmacyController.editMyProductPackage,
  )
  .put(
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("productPackages"),
    pharmacyController.removeMyProductPackage,
  );

router
  .route("/order")
  .get(
    aclController.usePharmacy("readOrders"),
    pharmacyController.requireLicenseModule("incomingOrders"),
    pharmacyController.getMyIncomingOrders,
  );

router
  .route("/order/:nodeId")
  .get(
    aclController.usePharmacy("readOrders"),
    pharmacyController.requireLicenseModule("incomingOrders"),
    pharmacyController.getMyIncomingOrder,
  )
  .patch(
    aclController.usePharmacy("mutateOrders"),
    pharmacyController.requireLicenseModule("incomingOrders"),
    pharmacyController.mutateIncomingOrderItem,
  );

router
  .route("/order/:nodeId/delivery")
  .get(
    aclController.usePharmacy("dispatchDelivery"),
    pharmacyController.requireLicenseModule("incomingOrders"),
    pharmacyController.getOrderDeliveryStatus,
  )
  .post(
    aclController.usePharmacy("dispatchDelivery"),
    pharmacyController.requireLicenseModule("incomingOrders"),
    pharmacyController.dispatchOrderDelivery,
  );

router
  .route("/tamin")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useAcl(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.getAdditiveDrugs,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.getTaminPrescription,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.preCheckPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.submitPrescription,
  );

router
  .route("/taminn")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.getSubmittedPrescInfo,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.removePrescription,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.usePharmacy(),
    pharmacyController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    pharmacyController.referrPresc,
  );

router
  .route("/license")
  .get(
    aclController.usePharmacy("readLicenses"),
    pharmacyController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.usePharmacy(), pharmacyController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BasePharmacyLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.usePharmacy("readLicenses"),
    pharmacyController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the pharmacy's own currently
// assigned PharmacyProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.usePharmacy("readLicenses"),
    pharmacyController.getMyCurrentLicense,
  );

// Purchase route (2026-09) - deliberately not gated by a specific action
// like "readLicenses" - this spends the pharmacy's own wallet balance, so a
// generic aclController.usePharmacy() presence check is enough, same as
// doctorRouter.ts's own purchase route. Not gated by requireLicenseModule
// either - see the comment block at the top of this file. The GET on the
// same path (a single plan's own detail page) is gated like "/license"
// above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.usePharmacy("readLicenses"),
    pharmacyController.getLicenseById,
  )
  .post(aclController.usePharmacy(), pharmacyController.purchaseLicense);

export default router;
