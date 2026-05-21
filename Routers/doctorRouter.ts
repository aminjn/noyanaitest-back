import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as autoController from "../Controllers/autoController";
import Clinic from "../Models/Clinic";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import * as aclController from "../Controllers/aclController";
import * as prescriptionController from "../Controllers/prescriptionController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.useDoctor(), doctorController.getMyDoctorProfile)
  .post(
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["specialities"]),
    doctorController.becomeDoctor,
  );

router
  .route("/request")
  .get(doctorController.getMyBecomeDoctorRequest)
  .post(doctorController.getMyMedicalSystemInfo);

router
  .route("/request/:nodeId")
  .get(doctorController.getMyMcCodeDetails)
  .put(doctorController.createMyDoctorProfile);

router
  .route("/profile")
  .post(
    aclController.useDoctor("mutateProfile"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields([
      "services",
      "specialities",
      "achivements",
    ]),
    doctorController.updateMyProfile,
  );

router
  .route("/clinic")
  .get(aclController.useDoctor("readClinics"), doctorController.getMyClinics)
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Clinic }),
  );

router
  .route("/clinic/:nodeId")
  .put(aclController.useDoctor("leaveClinics"), doctorController.leaveClinic);

router
  .route("/clinicjoin")
  .get(
    aclController.useDoctor("joinClinic"),
    doctorController.getMyJoinClinicRequests,
  )
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.submitAJoinClinicRequest,
  );

router
  .route("/clinicjoin/:nodeId")
  .post(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.toggleJoinClinicRequestStatus,
  )
  .put(
    aclController.useDoctor("joinClinic"),
    uploadController.upload.none(),
    doctorController.resubmitJoinClinicRequest,
  );

router
  .route("/clinicaddition")
  .get(
    aclController.useDoctor("clinicAddition"),
    doctorController.getMyClinicAdditionRequests,
  )
  .post(
    aclController.useDoctor("clinicAddition"),
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest,
  );

router
  .route("/calendar")
  .get(aclController.useDoctor("readCalendar"), doctorController.getSessions)
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.addSessions,
  );

router
  .route("/calendar/:stamp")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.getSessionsByDaySummary,
  );

router
  .route("/calendar/:stamp/full")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.getSessionsByDayFull,
  );

router
  .route("/session")
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.createSession,
  );

router
  .route("/session/:nodeId")
  .put(
    aclController.useDoctor("mutateCalendar"),
    doctorController.deleteSession,
  )
  .post(
    aclController.useDoctor("mutateCalendar"),
    uploadController.upload.none(),
    doctorController.editSession,
  );

router
  .route("/settings/:kind")
  .get(aclController.useDoctor("readSettings"), doctorController.getMySettings)
  .post(
    aclController.useDoctor("mutateSettings"),
    uploadController.upload.none(),
    doctorController.editMySettings,
  );

router
  .route("/insurance")
  .get(
    aclController.useDoctor("readInsurance"),
    doctorController.getMyInsurances,
  )
  .post(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Insurance }),
  );

router
  .route("/insurance/:nodeId")
  .post(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.addInsurance,
  )
  .put(
    aclController.useDoctor("mutateInsurance"),
    uploadController.upload.none(),
    doctorController.leaveInsurance,
  );

router
  .route("/insuranceaddition")
  .get(
    aclController.useDoctor("insuranceAddition"),
    doctorController.getMyInsuranceAdditions,
  )
  .post(
    aclController.useDoctor("insuranceAddition"),
    uploadController.upload.none(),
    doctorController.submitInsuranceAddition,
  );

router
  .route("/pharmacy")
  .get(
    aclController.useDoctor("readPharmacy"),
    doctorController.getMyPharmacies,
  )
  .post(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Pharmacy }),
  );

router
  .route("/pharmacy/:nodeId")
  .post(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.addPharmacy,
  )
  .put(
    aclController.useDoctor("mutatePharmacy"),
    uploadController.upload.none(),
    doctorController.leavePharmacy,
  );

router
  .route("/pharmacyaddition")
  .get(
    aclController.useDoctor("pharmacyAddition"),
    doctorController.getMyPharmacyAdditionRequests,
  )
  .post(
    aclController.useDoctor("pharmacyAddition"),
    uploadController.upload.none(),
    doctorController.submitPharmacyAdditionRequest,
  );

router
  .route("/patient")
  .get(aclController.useDoctor("readPatients"), doctorController.getMyPatients);

router
  .route("/patient/:nodeId")
  .get(aclController.useDoctor("readPatient"), doctorController.getMyPatient);

router
  .route("/patient/vital/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.getMyPatientVitals,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    uploadController.upload.none(),
    doctorController.addNewVital,
  );

router
  .route("/patient/file/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.getMyPatientFiles,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    uploadController.upload.none(),
    doctorController.newPatientFile,
  )
  .patch(
    aclController.useDoctor("mutatePatient"),
    uploadController.upload.none(),
    doctorController.editPatientFile,
  );

router
  .route("/patient/record/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.getPatientFileRecords,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    uploadController.upload.array("files"),
    doctorController.newPatientFileRecord,
  )
  .patch(
    aclController.useDoctor("mutatePatient"),
    uploadController.upload.none(),
    doctorController.editPatientFileRecord,
  );

router
  .route("/gallery")
  .get(
    aclController.useDoctor("readGallery"),
    uploadController.upload.none(),
    doctorController.getGallery,
  )
  .post(
    aclController.useDoctor("mutateGallery"),
    uploadController.upload.single("image"),
    doctorController.addGalleryItem,
  );

router
  .route("/gallery/:nodeId")
  .post(
    aclController.useDoctor("mutateGallery"),
    uploadController.upload.single("image"),
    doctorController.editGalleryItem,
  )
  .put(
    aclController.useDoctor("mutateGallery"),
    doctorController.removeGalleryItem,
  );

router
  .route("/office")
  .get(
    aclController.useDoctor("readOffices"),
    uploadController.upload.none(),
    doctorController.getMyOffices,
  )
  .post(
    aclController.useDoctor("mutateOffices"),
    uploadController.upload.none(),
    doctorController.createOffice,
  );

router
  .route("/office/:nodeId")
  .get(aclController.useDoctor("readOffices"), doctorController.getMyOffice)
  .post(
    aclController.useDoctor("mutateOffices"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["location"]),
    doctorController.editMyOffice,
  )
  .put(
    aclController.useDoctor("mutateOffices"),
    doctorController.removeMyOffice,
  );

router
  .route("/social")
  .get(
    aclController.useDoctor("mutateSocial"),
    doctorController.getMySocialMedias,
  )
  .post(
    aclController.useDoctor("readSocial"),
    uploadController.upload.none(),
    doctorController.createSocialMedia,
  );

router
  .route("/social/:nodeId")
  .post(
    aclController.useDoctor("mutateSocial"),
    uploadController.upload.none(),
    doctorController.editMySocialMedia,
  )
  .put(
    aclController.useDoctor("mutateSocial"),
    doctorController.removeMySocialMedia,
  );

router
  .route("/faq")
  .get(aclController.useDoctor("readFaq"), doctorController.getMyFaqs)
  .post(
    aclController.useDoctor("mutateFaq"),
    uploadController.upload.array("files"),
    doctorController.createFaq,
  );

router
  .route("/faq/:nodeId")
  .post(
    aclController.useDoctor("mutateFaq"),
    uploadController.upload.none(),
    doctorController.updateFaq,
  )
  .put(aclController.useDoctor("mutateFaq"), doctorController.deleteFaq);

router
  .route("/tamin")
  .get(aclController.useDoctor(), doctorController.checkTaminToken)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.taminCb,
  );

router
  .route("/tamin/token")
  .get(aclController.useDoctor(), doctorController.getTokenDate);

router
  .route("/presc")
  .get(aclController.useDoctor(), doctorController.getMyPrescriptions)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["items"]),
    doctorController.commitPrescription,
  )
  .put(
    aclController.useDoctor(),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["items"]),
    doctorController.draftPrescription,
  );

router
  .route("/presc/reload")
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.reloadPrescriptionFromTamin,
  );

router
  .route("/presc/patient")
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.inquiryPatient,
  );

router
  .route("/presc/privilege")
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.inquiryPatientPrivilege,
  );

router
  .route("/presc/patient/:nodeId")
  .get(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.getPatientFiles,
  );

router
  .route("/presc/profile/:nodeId")
  .get(aclController.useDoctor(), doctorController.getPatientProfile);

router
  .route("/presc/drug")
  .get(aclController.useDoctor(), doctorController.getMyFavoriteDrugs)
  .put(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.favoritePrescriptionItem,
  )
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.searchDrugs,
  );

router.route("/presc/lab").get();

router
  .route("/presc/instruction")
  .get(aclController.useDoctor(), doctorController.getPrescriptionInstructions);

router
  .route("/presc/usage")
  .get(aclController.useDoctor(), doctorController.getPrescriptionUsages);

router
  .route("/presc/amount")
  .get(aclController.useDoctor(), doctorController.getPrescriptionAmounts);

router
  .route("/presc/tamin/:nodeId")
  .get(aclController.useDoctor(), doctorController.getTaminPrescription)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.editTaminPrescription,
  )
  .put(aclController.useDoctor(), doctorController.deletePrescriptionFromTamin);

router
  .route("/presc/:nodeId")
  .get(aclController.useDoctor(), doctorController.getMyPrescription)
  .patch(aclController.useDoctor(), doctorController.commitDraftedPrescription)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.editDraftPrescription,
  )
  .put(
    aclController.useDoctor(),
    uploadController.upload.none(),
    doctorController.editCommitDraftPrescription,
  );

router
  .route("/taminSrvType")
  .get(aclController.useDoctor(), doctorController.getTaminServiceTypes);

router
  .route("/presc2/")
  .get(aclController.useDoctor(), prescriptionController.getPrescriptions)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    prescriptionController.createPrescription,
  );

router
  .route("/presc2/visit")
  .get(aclController.useDoctor(), prescriptionController.getVisitPrescriptions)
  .post(aclController.useDoctor(), prescriptionController.newVisitPrescription);

router
  .route("/presc2/visit/:nodeId")
  .put(
    aclController.useDoctor(),
    prescriptionController.deleteVisitPrescription,
  );

router
  .route("/presc2/:nodeId")
  .get(aclController.useDoctor(), prescriptionController.getPrescription)
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    prescriptionController.editPrescription,
  )
  .patch(aclController.useDoctor(), prescriptionController.commitPrescription)
  .put(aclController.useDoctor(), prescriptionController.deletePrescription);

router
  .route("/presc2/tamin/:nodeId")
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    prescriptionController.editTaminPrescription,
  )
  .put(
    aclController.useDoctor(),
    prescriptionController.deleteTaminPrescription,
  );

router
  .route("/referral")
  .get(
    aclController.useDoctor(),
    prescriptionController.getReferralPrescriptions,
  )
  .post(
    aclController.useDoctor(),
    uploadController.upload.none(),
    prescriptionController.submitReferralPrescription,
  );

router
  .route("/referral/base")
  .get(aclController.useDoctor(), prescriptionController.getReferralBaseData);

export default router;
