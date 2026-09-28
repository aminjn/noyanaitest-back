import express from "express";

import * as authControler from "../Controllers/authController";
import * as hospitalController from "../Controllers/hospitalController";
import * as aclController from "../Controllers/aclController";
import * as centerDoctorsController from "../Controllers/centerDoctorsController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router({ mergeParams: true });

router.use(authControler.protect);

// Note on hospitalController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useHospital(...) call so req.hospital
// is already set, mirroring doctorRouter.ts's/pharmacyRouter.ts's own
// comment. Two deliberate omissions:
//  - "/" (getMyHospitalProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the hospital is, same
//    "always visible, never gated" treatment HospitalPanelSidebar itself
//    gives the "profile" link (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a hospital with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useHospital(...) at all, since it runs
// before a Hospital profile even exists, so there's no req.hospital yet to
// check a license against - left untouched.

router
  .route("/")
  .get(aclController.useHospital(), hospitalController.getMyHospitalProfile)
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "hospital" }),
    hospitalController.becomeAHospital,
  );

router.route("/request").get(hospitalController.getMyBecomeHospitalRequest);

router
  .route("/profile")
  .post(
    aclController.useHospital(),
    hospitalController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "hospital" }),
    autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "location",
      "services",
      "certificates",
    ]),
    hospitalController.updateMyHospitalProfile,
  );

router
  .route("/license")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.useHospital(), hospitalController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseHospitalLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the hospital's own currently
// assigned HospitalProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getMyCurrentLicense,
  );

// Purchasing a license isn't gated by requireLicenseModule or a specific
// action like "readLicenses" - this spends the hospital's own wallet balance,
// so a generic aclController.useHospital() presence check is enough, same as
// doctorRouter.ts's/pharmacyRouter.ts's own purchase route. Not gated by
// requireLicenseModule for the same circularity reason as "/license" above.
// The GET on the same path (a single plan's own detail page) is gated like
// "/license" above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getLicenseById,
  )
  .post(aclController.useHospital(), hospitalController.purchaseLicense);


// the center's own doctors: members + join requests (owner only)
router
  .route("/doctor")
  .get(aclController.useHospital(true), centerDoctorsController.getMyDoctors("hospital"));
router
  .route("/doctor/request/:nodeId")
  .post(aclController.useHospital(true), centerDoctorsController.answerJoinRequest("hospital"));
router
  .route("/doctor/:nodeId")
  .delete(aclController.useHospital(true), centerDoctorsController.removeMyDoctor("hospital"));

export default router;
