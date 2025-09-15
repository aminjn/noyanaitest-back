import express from "express";

import * as authController from "../Controllers/authController";
import * as secretaryController from "../Controllers/secretaryController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/boss/:name")
  .get(authController.protect, secretaryController.getMyBosses);

router
  .route("/boss/:name/:nodeId")
  .post(authController.protect, secretaryController.mountBoss)
  .put(authController.protect, secretaryController.leaveBoss);

router
  .route("/request/:name")
  .get(authController.protect, secretaryController.getMyRequests);

router
  .route("/request/:name/:nodeId")
  .post(
    authController.protect,
    uploadController.upload.none(),
    secretaryController.toggleDoctorRequestStatus
  );

export default router;
