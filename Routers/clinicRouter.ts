import express from "express";

import * as authControler from "../Controllers/authController";
import * as clinicController from "../Controllers/clinicController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router({ mergeParams: true });

router.use(authControler.protect);

router
  .route("/")
  .get(aclController.useClinic(), clinicController.getMyClinicProfile)
  .post(uploadController.upload.none(), clinicController.becomeAClinic);

router.route("/request").get(clinicController.getMyBecomeClinicRequest);

router
  .route("/taminSpec")
  .get(aclController.useClinic(), clinicController.getTaminSpecs);

router
  .route("/tamin")
  .get(aclController.useClinic(), clinicController.checkTaminClinicToken)
  .post(aclController.useClinic(), clinicController.clinicTaminCallback);

router
  .route("/tamin/token")
  .get(aclController.useClinic(), clinicController.getClinicTaminToken);

router
  .route("/prescription")
  .post(
    aclController.useClinic(),
    uploadController.upload.none(),
    clinicController.getPrescriptions,
  )
  .put(
    aclController.useClinic(),
    uploadController.upload.none(),
    clinicController.submitTaminClinicPrescription,
  );

export default router;
