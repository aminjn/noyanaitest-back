import express from "express";

import * as authControler from "../Controllers/authController";
import * as clinicController from "../Controllers/clinicController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router({ mergeParams: true });

router.use(authControler.protect);

// Note on clinicController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useClinic(...) call so req.clinic
// is already set, mirroring doctorRouter.ts's/pharmacyRouter.ts's own
// comment. Two deliberate omissions:
//  - "/" (getMyClinicProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the clinic is, same
//    "always visible, never gated" treatment ClinicPanelSidebar itself
//    gives the "profile" link (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a clinic with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useClinic(...) at all, since it runs
// before a Clinic profile even exists, so there's no req.clinic yet to
// check a license against - left untouched.

router
  .route("/")
  .get(aclController.useClinic(), clinicController.getMyClinicProfile)
  .post(uploadController.upload.none(), clinicController.becomeAClinic);

router.route("/request").get(clinicController.getMyBecomeClinicRequest);

router
  .route("/profile")
  .post(
    aclController.useClinic(),
    clinicController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "clinic" }),
    autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "location",
      "services",
      "certificates",
    ]),
    clinicController.updateMyClinicProfile,
  );

router
  .route("/taminSpec")
  .get(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.getTaminSpecs,
  );

router
  .route("/tamin")
  .get(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.checkTaminClinicToken,
  )
  .post(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.clinicTaminCallback,
  );

router
  .route("/tamin/token")
  .get(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.getClinicTaminToken,
  );

router
  .route("/prescription")
  .post(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    clinicController.getPrescriptions,
  )
  .put(
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    clinicController.submitTaminClinicPrescription,
  );

router
  .route("/license")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.useClinic(), clinicController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseClinicLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getActiveLicenses,
  );

// Purchasing a license isn't gated by requireLicenseModule or a specific
// action like "readLicenses" - this spends the clinic's own wallet balance,
// so a generic aclController.useClinic() presence check is enough, same as
// doctorRouter.ts's/pharmacyRouter.ts's own purchase route. Not gated by
// requireLicenseModule for the same circularity reason as "/license" above.
// The GET on the same path (a single plan's own detail page) is gated like
// "/license" above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getLicenseById,
  )
  .post(aclController.useClinic(), clinicController.purchaseLicense);

export default router;
