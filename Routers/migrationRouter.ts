import express from "express";

import * as authController from "../Controllers/authController";
import * as migrationController from "../Controllers/migrationController";

const router = express.Router();

router
  .route("/doctor")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    migrationController.importDoctors
  )
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    migrationController.dropDoctors
  )
  .patch(
    authController.protect,
    authController.restrictTo("admin"),
    migrationController.purgeDoctors
  )
  .delete(
    authController.protect,
    authController.restrictTo("admin"),
    migrationController.dropAllDoctors
  );

export default router;
