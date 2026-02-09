import express from "express";

import * as authController from "../Controllers/authController";
import * as adminController from "../Controllers/adminController";
import * as uploadController from "../Controllers/uploadController";

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
    uploadController.upload.none(),
    adminController.testSip
  );

router
  .route("/call")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    uploadController.upload.none(),
    adminController.callUser
  );

router
  .route("/tity")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    uploadController.upload.none(),
    adminController.fillUserIdentity
  );

router
  .route("/pod")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.pod
  );

router
  .route("/tamin/serviceType")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminServiceTypes
  );

router
  .route("/tamin/prescriptionType")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPrescriptionTypes
  );

router
  .route("/tamin/service")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminServices
  );

router
  .route("/tamin/parTaref")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminParTarefs
  );

router
  .route("/tamin/drugUsage")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugUsages
  );

router
  .route("/tamin/drugInstruction")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugInstructions
  );

router
  .route("/tamin/drugAmount")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugAmounts
  );

router
  .route("/tamin/phPlan")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPhPlans
  );

router
  .route("/tamin/phIllness")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPhIllnesses
  );

export default router;
