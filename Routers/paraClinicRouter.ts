import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as paraClinicController from "../Controllers/paraClinicController";
import * as aclController from "../Controllers/aclController";
import * as autoController from "../Controllers/autoController";

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
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "paraClinic" }),
    autoController.mutateCompoundFields(["tags", "insurances", "location"]),
    paraClinicController.updateMyParaClinicProfile,
  );

router
  .route("/tamin")
  .post(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getPrescs,
  )
  .patch(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.precheckPrescription,
  )
  .put(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.submitPrescription,
  );

router
  .route("/taminn")
  .post(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getPrescription,
  )
  .put(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.deletePrescription,
  )
  .patch(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.registerDiagnosis,
  );

router
  .route("/icid")
  .get(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.getIcids,
  );

router
  .route("/test")
  .get(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.getAvailableTests,
  );

router
  .route("/order")
  .get(
    aclController.useParaClinic("readOrders"),
    paraClinicController.requireLicenseModule("incomingOrders"),
    paraClinicController.getMyIncomingOrders,
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
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.getMyTests,
  )
  .post(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tests"),
    uploadController.upload.none(),
    paraClinicController.addMyTest,
  );

router
  .route("/myTest/:nodeId")
  .post(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tests"),
    uploadController.upload.none(),
    paraClinicController.editMyTest,
  )
  .put(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tests"),
    paraClinicController.removeMyTest,
  );

router
  .route("/tamin/physio")
  .post(
    aclController.useParaClinic(),
    paraClinicController.requireLicenseModule("tamin"),
    uploadController.upload.none(),
    paraClinicController.registerPhysioSession,
  );

router
  .route("/tamin/session")
  .post(
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
  .post(aclController.useParaClinic(), paraClinicController.purchaseLicense);

export default router;
