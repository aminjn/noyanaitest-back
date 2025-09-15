import express from "express";

import * as authController from "../Controllers/authController";
import * as adminController from "../Controllers/adminController";
import * as uploadControlle from "../Controllers/uploadController";

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

router
  .route("/clinic/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromClinic
  );

router
  .route("/sip")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.testSip
  );

export default router;
