import express from "express";

import * as authController from "../Controllers/authController";
import * as adminController from "../Controllers/adminController";

const router = express.Router();

router
  .route("/")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    adminController.getMyAccessLevel
  );

router
  .route("/debug")
  .all(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.debug
  );

router
  .route("/doctorprofile/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromDoctorProfile
  );

export default router;
