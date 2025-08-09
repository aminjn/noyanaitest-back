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

router
  .route("/clinic")
  .get(
    authController.protect,
    doctorController.useDoctor,
    doctorController.getMyClinics
  )
  .post(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.searchClinics
  )
  .put(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest
  );

router
  .route("/clinic/:nodeId")
  .put(
    authController.protect,
    doctorController.useDoctor,
    doctorController.leaveClinic
  );

router
  .route("/clinicjoin")
  .get(
    authController.protect,
    doctorController.useDoctor,
    doctorController.getMyJoinClinicRequests
  )
  .post(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.submitAJoinClinicRequest
  );

router
  .route("/clinicjoin/:nodeId")
  .post(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.toggleJoinClinicRequestStatus
  )
  .put(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.resubmitJoinClinicRequest
  );

router
  .route("/clinicaddition")
  .get(
    authController.protect,
    doctorController.useDoctor,
    doctorController.getMyClinicAdditionRequests
  )
  .post(
    authController.protect,
    doctorController.useDoctor,
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest
  );

export default router;
