import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router
  .route("/")
  .get(authController.protect, doctorController.getMyDoctorProfile)
  .post(
    authController.protect,
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["specialities"]),
    doctorController.becomeDoctor
  );

router
  .route("/request")
  .get(authController.protect, doctorController.getMyBecomeDoctorRequest);

export default router;
