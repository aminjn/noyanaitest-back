import express from "express";

import * as authController from "../Controllers/authController";
import * as secretaryController from "../Controllers/secretaryController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/doctor")
  .get(authController.protect, secretaryController.getMyDoctors);

router
  .route("/doctor/:nodeId")
  .post(authController.protect, secretaryController.mountDoctor)
  .put(authController.protect, secretaryController.leaveDoctor);

router
  .route("/doctorrequest")
  .get(authController.protect, secretaryController.getMyDoctorRequests);

router
  .route("/doctorrequest/:nodeId")
  .post(
    authController.protect,
    uploadController.upload.none(),
    secretaryController.toggleDoctorRequestStatus
  );

export default router;
