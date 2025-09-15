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

export default router;
