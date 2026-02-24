import express from "express";

import * as authController from "../Controllers/authController";
import * as pharmacyController from "../Controllers/pharmacyController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.usePharmacy(), pharmacyController.getMyPharmacyProfile)
  .post(uploadController.upload.none(), pharmacyController.becomeAPharmacy);

router.route("/request").get(pharmacyController.getMyBecomePharmacyRequest);

router
  .route("/prescription")
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getPatientPrescriptions,
  )
  .put(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.fillPrescription,
  );

router
  .route("/drug")
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getDrugEquiv,
  );

export default router;
