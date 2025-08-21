import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router
  .route("/")
  .get(
    authController.protect,
    doctorController.useDoctor(),
    doctorController.getMyDoctorProfile
  )
  .post(
    authController.protect,
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["specialities"]),
    doctorController.becomeDoctor
  );

router
  .route("/acl")
  .get(
    authController.protect,
    doctorController.useDoctor(),
    doctorController.getMyDoctorAcl
  );

router
  .route("/request")
  .get(authController.protect, doctorController.getMyBecomeDoctorRequest);

router
  .route("/clinic")
  .get(
    authController.protect,
    doctorController.useDoctor("readClinics"),
    doctorController.getMyClinics
  )
  .post(
    authController.protect,
    doctorController.useDoctor(),
    uploadController.upload.none(),
    doctorController.searchClinics
  );

router
  .route("/clinic/:nodeId")
  .put(
    authController.protect,
    doctorController.useDoctor("leaveClinics"),
    doctorController.leaveClinic
  );

router
  .route("/clinicjoin")
  .get(
    authController.protect,
    doctorController.useDoctor("joinClinic"),
    doctorController.getMyJoinClinicRequests
  )
  .post(
    authController.protect,
    doctorController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.submitAJoinClinicRequest
  );

router
  .route("/clinicjoin/:nodeId")
  .post(
    authController.protect,
    doctorController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.toggleJoinClinicRequestStatus
  )
  .put(
    authController.protect,
    doctorController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.resubmitJoinClinicRequest
  );

router
  .route("/clinicaddition")
  .get(
    authController.protect,
    doctorController.useDoctor("clinicAddition"),
    doctorController.getMyClinicAdditionRequests
  )
  .post(
    authController.protect,
    doctorController.useDoctor("clinicAddition"),
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest
  );

router
  .route("/accesslevel")
  .get(
    authController.protect,
    doctorController.useDoctor(true),
    doctorController.getMyAccessLevels
  )
  .post(
    authController.protect,
    doctorController.useDoctor(true),
    uploadController.upload.none(),
    doctorController.createAccessLevel
  );

router
  .route("/accesslevel/:nodeId")
  .post(
    authController.protect,
    doctorController.useDoctor(true),
    uploadController.upload.none(),
    doctorController.editAccessLevel
  )
  .put(
    authController.protect,
    doctorController.useDoctor(true),
    doctorController.deleteAccessLevel
  );

router
  .route("/secretaryrequest")
  .get(
    authController.protect,
    doctorController.useDoctor(true),
    doctorController.getMySecretaryRequests
  )
  .post(
    authController.protect,
    doctorController.useDoctor(true),
    uploadController.upload.none(),
    doctorController.submitASecretaryRequest
  );

router
  .route("/secretaryrequest/:nodeId")
  .post(
    authController.protect,
    doctorController.useDoctor(true),
    uploadController.upload.none(),
    doctorController.editSecretaryRequest
  );

router
  .route("/secretary")
  .get(
    authController.protect,
    doctorController.useDoctor(true),
    doctorController.getMySecretaries
  );

router
  .route("/secretary/:nodeId")
  .post(
    authController.protect,
    doctorController.useDoctor(true),
    uploadController.upload.none(),
    doctorController.editMySecretary
  )
  .put(
    authController.protect,
    doctorController.useDoctor(true),
    doctorController.deleteMySecretary
  );

router
  .route("/calendar")
  .get(
    authController.protect,
    doctorController.useDoctor("readCalendar"),
    doctorController.getSessions
  )
  .post(
    authController.protect,
    doctorController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.addSessions
  );

router
  .route("/session/:nodeId")
  .put(
    authController.protect,
    doctorController.useDoctor("mutateCalendar"),
    doctorController.deleteSession
  );

export default router;
