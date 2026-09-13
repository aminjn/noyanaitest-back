import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as autoController from "../Controllers/autoController";
import Clinic from "../Models/Clinic";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import Hospital from "../Models/Hospital";
import * as aclController from "../Controllers/aclController";
import * as prescriptionController from "../Controllers/prescriptionController";
import * as featureGateController from "../Controllers/featureGateController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

// Note on doctorController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useDoctor(...) call so req.doctor
// is already set. Two deliberate omissions:
//  - "/" (getMyDoctorProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the doctor is, same
//    "always visible, never gated" treatment DoctorSidebar gives the
//    "dashboard" link itself (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a doctor with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// Routes with no aclController.useDoctor(...) at all ("/request*", the "/"
// POST becomeDoctor) run before a DoctorProfile even exists, so there's no
// req.doctor yet to check a license against - left untouched.

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
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.single("avatar"),
    autoController.mutateCompoundFields([
      "services",
      "specialities",
      "achivements",
    ]),
    doctorController.updateMyProfile,
  );

router
  .route("/clinic")
  .get(
    aclController.useDoctor("readClinics"),
    doctorController.requireLicenseModule("clinics"),
    doctorController.getMyClinics,
  )
  .post(
    aclController.useDoctor("joinClinic"),
    doctorController.requireLicenseModule("clinics"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Clinic }),
  );

router
  .route("/clinic/:nodeId")
  .put(
    aclController.useDoctor("leaveClinics"),
    doctorController.requireLicenseModule("clinics"),
    doctorController.leaveClinic,
  );

router
  .route("/clinicjoin")
  .get(
    aclController.useDoctor("joinClinic"),
    doctorController.requireLicenseModule("clinics"),
    doctorController.getMyJoinClinicRequests,
  )
  .post(
    aclController.useDoctor("joinClinic"),
    doctorController.requireLicenseModule("clinics"),
    uploadController.upload.none(),
    doctorController.submitAJoinClinicRequest,
  );

router
  .route("/clinicjoin/:nodeId")
  .post(
    aclController.useDoctor("joinClinic"),
    doctorController.requireLicenseModule("clinics"),
    uploadController.upload.none(),
    doctorController.toggleJoinClinicRequestStatus,
  )
  .put(
    aclController.useDoctor("joinClinic"),
    doctorController.requireLicenseModule("clinics"),
    uploadController.upload.none(),
    doctorController.resubmitJoinClinicRequest,
  );

router
  .route("/clinicaddition")
  .get(
    aclController.useDoctor("clinicAddition"),
    doctorController.requireLicenseModule("clinics"),
    doctorController.getMyClinicAdditionRequests,
  )
  .post(
    aclController.useDoctor("clinicAddition"),
    doctorController.requireLicenseModule("clinics"),
    uploadController.upload.none(),
    doctorController.submitAClinicAdditionRequest,
  );

// Hospital counterparts of the clinic routes above (2026-09) - mirrors every
// route/gate 1:1, minus prescriptions (hospitals don't have that module).
router
  .route("/hospital")
  .get(
    aclController.useDoctor("readHospitals"),
    doctorController.requireLicenseModule("hospitals"),
    doctorController.getMyHospitals,
  )
  .post(
    aclController.useDoctor("joinHospital"),
    doctorController.requireLicenseModule("hospitals"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Hospital }),
  );

router
  .route("/hospital/:nodeId")
  .put(
    aclController.useDoctor("leaveHospitals"),
    doctorController.requireLicenseModule("hospitals"),
    doctorController.leaveHospital,
  );

router
  .route("/hospitaljoin")
  .get(
    aclController.useDoctor("joinHospital"),
    doctorController.requireLicenseModule("hospitals"),
    doctorController.getMyJoinHospitalRequests,
  )
  .post(
    aclController.useDoctor("joinHospital"),
    doctorController.requireLicenseModule("hospitals"),
    uploadController.upload.none(),
    doctorController.submitAJoinHospitalRequest,
  );

router
  .route("/hospitaljoin/:nodeId")
  .post(
    aclController.useDoctor("joinHospital"),
    doctorController.requireLicenseModule("hospitals"),
    uploadController.upload.none(),
    doctorController.toggleJoinHospitalRequestStatus,
  )
  .put(
    aclController.useDoctor("joinHospital"),
    doctorController.requireLicenseModule("hospitals"),
    uploadController.upload.none(),
    doctorController.resubmitJoinHospitalRequest,
  );

router
  .route("/hospitaladdition")
  .get(
    aclController.useDoctor("hospitalAddition"),
    doctorController.requireLicenseModule("hospitals"),
    doctorController.getMyHospitalAdditionRequests,
  )
  .post(
    aclController.useDoctor("hospitalAddition"),
    doctorController.requireLicenseModule("hospitals"),
    uploadController.upload.none(),
    doctorController.submitAHospitalAdditionRequest,
  );

router
  .route("/calendar")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getSessions,
  )
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    uploadController.upload.none(),
    doctorController.addSessions,
  );

router
  .route("/calendar/:stamp")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getSessionsByDaySummary,
  );

router
  .route("/calendar/:stamp/full")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getSessionsByDayFull,
  );

router
  .route("/reservation/:nodeId")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getMyDoctorReservation,
  );

router
  .route("/reservation/:nodeId/check-in")
  .patch(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.checkInReservation,
  );

router
  .route("/schedule")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("schedule"),
    doctorController.getMySchedule,
  );

router
  .route("/session")
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    uploadController.upload.none(),
    doctorController.createSession,
  );

router
  .route("/session/:nodeId")
  .put(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.deleteSession,
  )
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    uploadController.upload.none(),
    doctorController.editSession,
  );

router
  .route("/settings/:kind")
  .get(
    aclController.useDoctor("readSettings"),
    doctorController.requireLicenseModule("settings"),
    doctorController.getMySettings,
  )
  .post(
    aclController.useDoctor("mutateSettings"),
    doctorController.requireLicenseModule("settings"),
    uploadController.upload.none(),
    doctorController.editMySettings,
  );

router
  .route("/insurance")
  .get(
    aclController.useDoctor("readInsurance"),
    doctorController.requireLicenseModule("insurances"),
    doctorController.getMyInsurances,
  )
  .post(
    aclController.useDoctor("mutateInsurance"),
    doctorController.requireLicenseModule("insurances"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Insurance }),
  );

router
  .route("/insurance/:nodeId")
  .post(
    aclController.useDoctor("mutateInsurance"),
    doctorController.requireLicenseModule("insurances"),
    uploadController.upload.none(),
    doctorController.addInsurance,
  )
  .put(
    aclController.useDoctor("mutateInsurance"),
    doctorController.requireLicenseModule("insurances"),
    uploadController.upload.none(),
    doctorController.leaveInsurance,
  );

router
  .route("/insuranceaddition")
  .get(
    aclController.useDoctor("insuranceAddition"),
    doctorController.requireLicenseModule("insurances"),
    doctorController.getMyInsuranceAdditions,
  )
  .post(
    aclController.useDoctor("insuranceAddition"),
    doctorController.requireLicenseModule("insurances"),
    uploadController.upload.none(),
    doctorController.submitInsuranceAddition,
  );

router
  .route("/pharmacy")
  .get(
    aclController.useDoctor("readPharmacy"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    doctorController.getMyPharmacies,
  )
  .post(
    aclController.useDoctor("mutatePharmacy"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    uploadController.upload.none(),
    doctorController.searchShitByName({ model: Pharmacy }),
  );

router
  .route("/pharmacy/:nodeId")
  .post(
    aclController.useDoctor("mutatePharmacy"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    uploadController.upload.none(),
    doctorController.addPharmacy,
  )
  .put(
    aclController.useDoctor("mutatePharmacy"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    uploadController.upload.none(),
    doctorController.leavePharmacy,
  );

router
  .route("/pharmacyaddition")
  .get(
    aclController.useDoctor("pharmacyAddition"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    doctorController.getMyPharmacyAdditionRequests,
  )
  .post(
    aclController.useDoctor("pharmacyAddition"),
    doctorController.requireLicenseModule("phrmaciesAndLabs"),
    uploadController.upload.none(),
    doctorController.submitPharmacyAdditionRequest,
  );

router
  .route("/patient")
  .get(
    aclController.useDoctor("readPatients"),
    doctorController.requireLicenseModule("patients"),
    doctorController.getMyPatients,
  );

router
  .route("/patient/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.requireLicenseModule("patients"),
    doctorController.getMyPatient,
  );

router
  .route("/patient/vital/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.requireLicenseModule("patients"),
    doctorController.getMyPatientVitals,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    doctorController.requireLicenseModule("patients"),
    uploadController.upload.none(),
    doctorController.addNewVital,
  );

router
  .route("/patient/file/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.requireLicenseModule("patients"),
    doctorController.getMyPatientFiles,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    doctorController.requireLicenseModule("patients"),
    uploadController.upload.none(),
    doctorController.newPatientFile,
  )
  .patch(
    aclController.useDoctor("mutatePatient"),
    doctorController.requireLicenseModule("patients"),
    uploadController.upload.none(),
    doctorController.editPatientFile,
  );

router
  .route("/patient/record/:nodeId")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.requireLicenseModule("patients"),
    doctorController.getPatientFileRecords,
  )
  .post(
    aclController.useDoctor("mutatePatient"),
    doctorController.requireLicenseModule("patients"),
    uploadController.upload.array("files"),
    doctorController.newPatientFileRecord,
  )
  .patch(
    aclController.useDoctor("mutatePatient"),
    doctorController.requireLicenseModule("patients"),
    uploadController.upload.none(),
    doctorController.editPatientFileRecord,
  );

router
  .route("/gallery")
  .get(
    aclController.useDoctor("readGallery"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.none(),
    doctorController.getGallery,
  )
  .post(
    aclController.useDoctor("mutateGallery"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.single("image"),
    doctorController.addGalleryItem,
  );

router
  .route("/gallery/:nodeId")
  .post(
    aclController.useDoctor("mutateGallery"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.single("image"),
    doctorController.editGalleryItem,
  )
  .put(
    aclController.useDoctor("mutateGallery"),
    doctorController.requireLicenseModule("profile"),
    doctorController.removeGalleryItem,
  );

router
  .route("/office")
  .get(
    aclController.useDoctor("readOffices"),
    doctorController.requireLicenseModule("office"),
    uploadController.upload.none(),
    doctorController.getMyOffices,
  )
  .post(
    aclController.useDoctor("mutateOffices"),
    doctorController.requireLicenseModule("office"),
    uploadController.upload.none(),
    doctorController.createOffice,
  );

router
  .route("/office/:nodeId")
  .get(
    aclController.useDoctor("readOffices"),
    doctorController.requireLicenseModule("office"),
    doctorController.getMyOffice,
  )
  .post(
    aclController.useDoctor("mutateOffices"),
    doctorController.requireLicenseModule("office"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["location"]),
    doctorController.editMyOffice,
  )
  .put(
    aclController.useDoctor("mutateOffices"),
    doctorController.requireLicenseModule("office"),
    doctorController.removeMyOffice,
  );

router
  .route("/service")
  .get(
    aclController.useDoctor("readServices"),
    doctorController.requireLicenseModule("services"),
    uploadController.upload.none(),
    doctorController.getMyServices,
  )
  .post(
    aclController.useDoctor("mutateServices"),
    doctorController.requireLicenseModule("services"),
    uploadController.upload.single("image"),
    autoController.mutateCompoundFields(["sameAs"]),
    doctorController.createService,
  );

router
  .route("/service/:nodeId")
  .get(
    aclController.useDoctor("readServices"),
    doctorController.requireLicenseModule("services"),
    doctorController.getMyService,
  )
  .post(
    aclController.useDoctor("mutateServices"),
    doctorController.requireLicenseModule("services"),
    uploadController.upload.single("image"),
    autoController.mutateCompoundFields(["sameAs"]),
    doctorController.editMyService,
  )
  .put(
    aclController.useDoctor("mutateServices"),
    doctorController.requireLicenseModule("services"),
    doctorController.removeMyService,
  );

router
  .route("/servicepackage")
  .get(
    aclController.useDoctor("readServicePackages"),
    doctorController.requireLicenseModule("servicePackages"),
    uploadController.upload.none(),
    doctorController.getMyServicePackages,
  )
  .post(
    aclController.useDoctor("mutateServicePackages"),
    doctorController.requireLicenseModule("servicePackages"),
    uploadController.upload.single("image"),
    autoController.mutateCompoundFields(["services", "sameAs"]),
    doctorController.createServicePackage,
  );

router
  .route("/order")
  .get(
    aclController.useDoctor("readOrders"),
    doctorController.requireLicenseModule("incomingOrders"),
    doctorController.getMyIncomingOrders,
  );

router
  .route("/order/:nodeId")
  .get(
    aclController.useDoctor("readOrders"),
    doctorController.requireLicenseModule("incomingOrders"),
    doctorController.getMyIncomingOrder,
  )
  .patch(
    aclController.useDoctor("mutateOrders"),
    doctorController.requireLicenseModule("incomingOrders"),
    doctorController.mutateIncomingOrderItem,
  );

router
  .route("/servicepackage/:nodeId")
  .get(
    aclController.useDoctor("readServicePackages"),
    doctorController.requireLicenseModule("servicePackages"),
    doctorController.getMyServicePackage,
  )
  .post(
    aclController.useDoctor("mutateServicePackages"),
    doctorController.requireLicenseModule("servicePackages"),
    uploadController.upload.single("image"),
    autoController.mutateCompoundFields(["services", "sameAs"]),
    doctorController.editMyServicePackage,
  )
  .put(
    aclController.useDoctor("mutateServicePackages"),
    doctorController.requireLicenseModule("servicePackages"),
    doctorController.removeMyServicePackage,
  );

router
  .route("/social")
  .get(
    aclController.useDoctor("mutateSocial"),
    doctorController.requireLicenseModule("profile"),
    doctorController.getMySocialMedias,
  )
  .post(
    aclController.useDoctor("readSocial"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.none(),
    doctorController.createSocialMedia,
  );

router
  .route("/social/:nodeId")
  .post(
    aclController.useDoctor("mutateSocial"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.none(),
    doctorController.editMySocialMedia,
  )
  .put(
    aclController.useDoctor("mutateSocial"),
    doctorController.requireLicenseModule("profile"),
    doctorController.removeMySocialMedia,
  );

router
  .route("/faq")
  .get(
    aclController.useDoctor("readFaq"),
    doctorController.requireLicenseModule("profile"),
    doctorController.getMyFaqs,
  )
  .post(
    aclController.useDoctor("mutateFaq"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.array("files"),
    doctorController.createFaq,
  );

router
  .route("/faq/:nodeId")
  .post(
    aclController.useDoctor("mutateFaq"),
    doctorController.requireLicenseModule("profile"),
    uploadController.upload.none(),
    doctorController.updateFaq,
  )
  .put(
    aclController.useDoctor("mutateFaq"),
    doctorController.requireLicenseModule("profile"),
    doctorController.deleteFaq,
  );

router
  .route("/tamin")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.checkTaminToken,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.taminCb,
  );

router
  .route("/tamin/token")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getTokenDate,
  );

router
  .route("/presc")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getMyPrescriptions,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["items"]),
    doctorController.commitPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["items"]),
    doctorController.draftPrescription,
  );

router
  .route("/presc/reload")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.reloadPrescriptionFromTamin,
  );

router
  .route("/presc/patient")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.inquiryPatient,
  );

router
  .route("/presc/privilege")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.inquiryPatientPrivilege,
  );

router
  .route("/presc/patient/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.getPatientFiles,
  );

router
  .route("/presc/profile/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getPatientProfile,
  );

router
  .route("/presc/drug")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getMyFavoriteDrugs,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.favoritePrescriptionItem,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.searchDrugs,
  );

router.route("/presc/lab").get();

router
  .route("/presc/instruction")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getPrescriptionInstructions,
  );

router
  .route("/presc/usage")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getPrescriptionUsages,
  );

router
  .route("/presc/amount")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getPrescriptionAmounts,
  );

router
  .route("/presc/tamin/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getTaminPrescription,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.editTaminPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.deletePrescriptionFromTamin,
  );

router
  .route("/presc/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getMyPrescription,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.commitDraftedPrescription,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.editDraftPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    doctorController.editCommitDraftPrescription,
  );

router
  .route("/taminSrvType")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    doctorController.getTaminServiceTypes,
  );

router
  .route("/presc2/")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.getPrescriptions,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    prescriptionController.createPrescription,
  );

router
  .route("/presc2/visit")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.getVisitPrescriptions,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.newVisitPrescription,
  );

router
  .route("/presc2/visit/:nodeId")
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.deleteVisitPrescription,
  );

router
  .route("/presc2/:nodeId")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.getPrescription,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    prescriptionController.editPrescription,
  )
  .patch(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.commitPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.deletePrescription,
  );

router
  .route("/presc2/tamin/:nodeId")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    prescriptionController.editTaminPrescription,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.deleteTaminPrescription,
  );

router
  .route("/referral")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.getReferralPrescriptions,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    uploadController.upload.none(),
    prescriptionController.submitReferralPrescription,
  );

router
  .route("/referral/base")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useDoctor(),
    doctorController.requireLicenseModule("drugsAndPrescriptions"),
    prescriptionController.getReferralBaseData,
  );

router
  .route("/license")
  .get(
    aclController.useDoctor("readLicenses"),
    doctorController.getMyLicenseOverview,
  );

// The resolved set of modules this doctor currently has access to
// (2026-09) - deliberately gated only by base doctor access (no specific
// ACL action, unlike "/license" above), since the frontend needs this on
// every doctorpanel page to show a friendly "not covered by your license"
// notice, regardless of whether the current user can see the licenses tab
// itself.
router
  .route("/license/modules")
  .get(aclController.useDoctor(), doctorController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseDoctorLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useDoctor("readLicenses"),
    doctorController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the doctor's own currently
// assigned DoctorProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.useDoctor("readLicenses"),
    doctorController.getMyCurrentLicense,
  );

// Purchase gated by full/owner access only (no action arg) rather than
// "readLicenses" - this spends the doctor's own wallet balance, so a
// delegated secretary who can only view the licenses tab shouldn't be able
// to trigger a purchase, same conservative default as the secretary/
// access-level management routes. Not gated by requireLicenseModule either -
// see the file-level note at the top. The GET on the same path (a single
// plan's own detail page) is gated like "/license" above, since it's just
// another read of the catalog.
router
  .route("/license/:nodeId")
  .get(aclController.useDoctor("readLicenses"), doctorController.getLicenseById)
  .post(aclController.useDoctor(), doctorController.purchaseLicense);

router
  .route("/shift")
  .get(
    aclController.useDoctor(),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getShifts,
  )
  .post(
    aclController.useDoctor(),
    doctorController.requireLicenseModule("shifts"),
    uploadController.upload.none(),
    doctorController.setShifts,
  );

export default router;
