import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as autoController from "../Controllers/autoController";
import Clinic from "../Models/Clinic";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import * as aclController from "../Controllers/aclController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.useDoctor(), doctorController.getMyDoctorProfile)
  .post(
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["specialities"]),
    doctorController.becomeDoctor
  );

router.route("/request").get(doctorController.getMyBecomeDoctorRequest);

router
  .route("/clinic")
  .get(aclController.useDoctor("readClinics"), doctorController.getMyClinics)
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Clinic })
  );

router
  .route("/clinic/:nodeId")
  .put(aclController.useDoctor("leaveClinics"), doctorController.leaveClinic);

router
  .route("/clinicjoin")
  .get(
    aclController.useDoctor("joinClinic"),
    doctorController.getMyJoinClinicRequests
  )
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.submitAJoinClinicRequest
  );

router
  .route("/clinicjoin/:nodeId")
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.toggleJoinClinicRequestStatus
  )
  .put(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.resubmitJoinClinicRequest
  );

router
  .route("/clinicaddition")
  .get(
    aclController.useDoctor("clinicAddition"),
    doctorController.getMyClinicAdditionRequests
  )
  .post(
    aclController.useDoctor("clinicAddition"),
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest
  );

router
  .route("/calendar")
  .get(aclController.useDoctor("readCalendar"), doctorController.getSessions)
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.addSessions
  );

router
  .route("/calendar/:stamp")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.getSessionsByDaySummary
  );

router
  .route("/calendar/:stamp/full")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.getSessionsByDayFull
  );

router
  .route("/session")
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.createSession
  );

router
  .route("/session/:nodeId")
  .put(
    aclController.useDoctor("mutateCalendar"),
    doctorController.deleteSession
  )
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.editSession
  );

router
  .route("/settings/:kind")
  .get(aclController.useDoctor("readSettings"), doctorController.getMySettings)
  .post(
    aclController.useDoctor("mutateSettings"),
    uploadController.upload.none(),
    doctorController.editMySettings
  );

router
  .route("/insurance")
  .get(
    aclController.useDoctor("readInsurance"),
    doctorController.getMyInsurances
  )
  .post(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Insurance })
  );

router
  .route("/insurance/:nodeId")
  .post(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.addInsurance
  )
  .put(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.leaveInsurance
  );

router
  .route("/insuranceaddition")
  .get(
    aclController.useDoctor("insuranceAddition"),
    doctorController.getMyInsuranceAdditions
  )
  .post(
    aclController.useDoctor("insuranceAddition"),
    uploadController.upload.none(),
    doctorController.submitInsuranceAddition
  );

router
  .route("/pharmacy")
  .get(
    aclController.useDoctor("readPharmacy"),
    doctorController.getMyPharmacies
  )
  .post(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Pharmacy })
  );

router
  .route("/pharmacy/:nodeId")
  .post(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.addPharmacy
  )
  .put(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.leavePharmacy
  );

router
  .route("/pharmacyaddition")
  .get(
    aclController.useDoctor("pharmacyAddition"),
    doctorController.getMyPharmacyAdditionRequests
  )
  .post(
    aclController.useDoctor("pharmacyAddition"),
    uploadController.upload.none(),
    doctorController.submitPharmacyAdditionRequest
  );

export default router;
