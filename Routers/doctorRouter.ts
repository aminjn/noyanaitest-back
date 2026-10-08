import { businessRouter } from "./businessRoutes";
import { syncDoctorPublished } from "../Lib/doctorPublish";
import { payrollRouter } from "./payrollRoutes";
import { crmRouter } from "./crmRoutes";
import { kartablRouter } from "./kartablRoutes";
import { moadianRouter } from "./moadianRoutes";
import { ownerOfReq } from "../Controllers/businessController";
import * as visitController from "../Controllers/visitController";
import * as chatController from "../Controllers/chatController";
import * as deskController from "../Controllers/doctorDeskController";
import express from "express";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as doctorController from "../Controllers/doctorController";
import * as serviceCatalogController from "../Controllers/serviceCatalogController";
import * as autoController from "../Controllers/autoController";
import Clinic from "../Models/Clinic";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import Hospital from "../Models/Hospital";
import * as aclController from "../Controllers/aclController";
import * as reviewController from "../Controllers/reviewController";
import * as prescriptionController from "../Controllers/prescriptionController";
import * as patientTimelineController from "../Controllers/doctorPatientTimelineController";
import * as featureGateController from "../Controllers/featureGateController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);
// after any successful change in the panel, a self-onboarded draft is
// published (or back to draft) by the bookable rule (Lib/doctorPublish.ts)
router.use((req, res, next) => {
  if (req.method !== "GET")
    res.on("finish", () => {
      const doctorId = (req as any).doctor?._id;
      if (res.statusCode < 400 && doctorId) syncDoctorPublished(doctorId).catch(() => {});
    });
  next();
});

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
      "serviceCategories",
      "specialities",
      "achivements",
    ]),
    doctorController.updateMyProfile,
  );

// the profile's services come from the catalogue: the picker's options, and
// adding a missing one inline (deduplicated, live for this doctor, reviewed
// by the admin - Controllers/serviceCatalogController.ts)
router
  .route("/serviceCatalog")
  .get(
    aclController.useDoctor("mutateProfile"),
    doctorController.requireLicenseModule("profile"),
    serviceCatalogController.getDoctorServiceOptions,
  )
  .post(
    aclController.useDoctor("mutateProfile"),
    doctorController.requireLicenseModule("profile"),
    serviceCatalogController.createDoctorService,
  );

// Working with centres (owner decision 2026-10, the Doctolib / Practo rule
// that a practitioner is never charged to be listed under a practice): any
// doctor, whatever the plan, sees the centres they belong to, answers a
// centre's invite (toggleJoin*RequestStatus) and leaves. Only what the
// doctor starts stays behind the plan's "clinics" / "hospitals" module:
// searching centres to ask, sending or resending their own join request,
// and suggesting a missing centre (the *addition routes).
router
  .route("/clinic")
  .get(
    aclController.useDoctor("readClinics"),
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
    doctorController.leaveClinic,
  );

router
  .route("/clinicjoin")
  .get(
    aclController.useDoctor("readClinics"),
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
    aclController.useDoctor("mutateJoinClinic"),
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
    doctorController.leaveHospital,
  );

router
  .route("/hospitaljoin")
  .get(
    aclController.useDoctor("readHospitals"),
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
    aclController.useDoctor("mutateJoinHospital"),
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
    doctorController.requireLicenseModule("schedule"),
    doctorController.getMyDoctorReservation,
  );

// Pre-visit answers, visit note and AI scribe (owner only, see
// visitController).
router
  .route("/reservation/:nodeId/visit")
  .get(
    aclController.useDoctor("readCalendar"),
    doctorController.requireLicenseModule("schedule"),
    visitController.getVisitRecord,
  );

router
  .route("/reservation/:nodeId/visit/note")
  .put(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    visitController.saveVisitNote,
  );

router
  .route("/reservation/:nodeId/visit/draft")
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    // the AI policy decides (feature "clinical.noteDraft", Lib/ai/aiGate.ts)
    visitController.draftNote,
  );

router
  .route("/reservation/:nodeId/visit/transcribe")
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    // the AI policy decides (feature "clinical.scribe", in minutes)
    visitController.audioUpload,
    visitController.transcribeVisit,
  );

router
  .route("/reservation/:nodeId/check-in")
  .patch(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    doctorController.checkInReservation,
  );

router
  .route("/reservation/:nodeId/no-show")
  .patch(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    doctorController.markReservationNoShow,
  );

// «پرداخت دریافت شد»: a visit paid at the desk (Lib/business/reservationInsurance.ts)
router
  .route("/reservation/:nodeId/desk-paid")
  .patch(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    doctorController.confirmDeskPaid,
  );

router
  .route("/reservation/:nodeId/cancel")
  .patch(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    uploadController.upload.none(),
    doctorController.cancelReservationByDoctor,
  );

router
  .route("/schedule")
  .get(
    aclController.useDoctor("readSchedule"),
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

// visits, notes, prescriptions and records in one list (2026-10)
router
  .route("/patient/:nodeId/timeline")
  .get(
    aclController.useDoctor("readPatient"),
    doctorController.requireLicenseModule("patients"),
    patientTimelineController.getPatientTimeline,
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
    aclController.useDoctor("readSocial"),
    doctorController.requireLicenseModule("profile"),
    doctorController.getMySocialMedias,
  )
  .post(
    aclController.useDoctor("mutateSocial"),
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

router.route("/tamin/token").get(
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

router.route("/presc/reload").post(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  uploadController.upload.none(),
  doctorController.reloadPrescriptionFromTamin,
);

router.route("/presc/patient").post(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  uploadController.upload.none(),
  doctorController.inquiryPatient,
);

router.route("/presc/privilege").post(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  uploadController.upload.none(),
  doctorController.inquiryPatientPrivilege,
);

router.route("/presc/patient/:nodeId").get(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  uploadController.upload.none(),
  doctorController.getPatientFiles,
);

router.route("/presc/profile/:nodeId").get(
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

router.route("/presc/instruction").get(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  doctorController.getPrescriptionInstructions,
);

router.route("/presc/usage").get(
  featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
  aclController.useDoctor(),
  doctorController.requireLicenseModule("drugsAndPrescriptions"),
  doctorController.getPrescriptionUsages,
);

router.route("/presc/amount").get(
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

router.route("/taminSrvType").get(
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

router.route("/presc2/visit/:nodeId").put(
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

router.route("/referral/base").get(
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
  .route("/finance")
  .get(
    aclController.useDoctor("readFinance"),
    // the finance page is a plan module, not only a menu item
    doctorController.requireLicenseModule("financialMangement"),
    doctorController.getMyFinance,
  );

// The doctor's balance for the panel menu (2026-10): the doctor's own
// wallet, also when a secretary with "readFinance" is logged in (GET
// /finance would show the secretary's wallet).
router
  .route("/balance")
  .get(aclController.useDoctor("readFinance"), doctorController.getMyBalance);

// The doctor's inbox (2026-10): same chat endpoints as /chat, but for the
// doctor's account, so a secretary with "readChat" works the doctor's chats.
router
  .route("/chat")
  .get(aclController.useDoctor("readChat"), chatController.actAsDoctor, chatController.getMyChats);
// unread messages in the practice inbox (the panel's chat tab badge);
// before "/chat/:nodeId"
router
  .route("/chat/unread")
  .get(aclController.useDoctor("readChat"), chatController.actAsDoctor, chatController.getMyUnreadCount);
router
  .route("/chat/:nodeId/close")
  .patch(aclController.useDoctor("readChat"), chatController.actAsDoctor, chatController.closeMyChat);
router
  .route("/chat/message/:nodeId")
  .get(aclController.useDoctor("readChat"), chatController.actAsDoctor, chatController.getMessage);
router
  .route("/chat/:nodeId")
  .get(aclController.useDoctor("readChat"), chatController.actAsDoctor, chatController.getMyChat)
  .post(
    aclController.useDoctor("readChat"),
    chatController.actAsDoctor,
    uploadController.upload.single("file"),
    chatController.sendMessage,
  );

// Front desk (2026-10): free slots, desk / phone bookings, moving a visit,
// days off. Same rights as the agenda: read with readSchedule, change with
// mutateCalendar.
router
  .route("/desk/slots")
  .get(
    aclController.useDoctor("readSchedule"),
    doctorController.requireLicenseModule("schedule"),
    deskController.getDeskSlots,
  );
router
  .route("/desk/patients")
  .get(
    aclController.useDoctor("readSchedule"),
    doctorController.requireLicenseModule("schedule"),
    deskController.searchDeskPatients,
  );
router
  .route("/desk/reservation")
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    deskController.createDeskReservation,
  );
router
  .route("/reservation/:nodeId/move")
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("schedule"),
    deskController.moveReservation,
  );
router
  .route("/timeoff")
  .get(aclController.useDoctor("readShifts"), deskController.getTimeOff)
  .post(aclController.useDoctor("mutateCalendar"), deskController.addTimeOff);
router
  .route("/timeoff/:nodeId")
  .delete(aclController.useDoctor("mutateCalendar"), deskController.removeTimeOff);

// Panel home. Each section inside is filtered by the caller's ACL.
router
  .route("/dashboard")
  .get(aclController.useDoctor(), doctorController.getMyDashboard);

// verified visit reviews behind the public score; the owner answers each
// one publicly, once (2026-10)
router.route("/review").get(aclController.useDoctor(), reviewController.getMyDoctorReviews);
router
  .route("/review/:nodeId/reply")
  .post(aclController.useDoctor(true), uploadController.upload.none(), reviewController.replyToMyDoctorReview);

router
  .route("/license/current")
  .get(
    aclController.useDoctor("readLicenses"),
    doctorController.getMyCurrentLicense,
  );

// Purchase gated by owner access only (useDoctor(true) - secretaries are
// always refused; a bare useDoctor() would let any mounted secretary in)
// rather than
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
  .post(aclController.useDoctor(true), doctorController.purchaseLicense);

// Shifts drive the booking calendar, so editing them reuses the calendar
// mutate permission (there is no separate mutateShifts action).
router
  .route("/shift")
  .get(
    aclController.useDoctor("readShifts"),
    doctorController.requireLicenseModule("shifts"),
    doctorController.getShifts,
  )
  .post(
    aclController.useDoctor("mutateCalendar"),
    doctorController.requireLicenseModule("shifts"),
    uploadController.upload.none(),
    doctorController.setShifts,
  );

// Noyan Business accounting (2026-10, Lib/business): the doctor's own books.
// Read with readFinance, write with manageAccounting; the plan's
// "accounting" module opens it.
router.use(
  "/biz",
  businessRouter({
    ownerOf: ownerOfReq("doctor"),
    read: [aclController.useDoctor("readFinance"), doctorController.requireLicenseModule("accounting")],
    write: [aclController.useDoctor("manageAccounting"), doctorController.requireLicenseModule("accounting")],
    approve: [aclController.useDoctor("approveVouchers"), doctorController.requireLicenseModule("accounting")],
  }),
);

// Noyan Business payroll (2026-10, Lib/business/payroll.ts): employees, the
// month's payslips with insurance and tax, and their payments. Read with
// readPayroll, write with managePayroll; the plan's "payroll" module opens it.
router.use(
  "/payroll",
  payrollRouter({
    ownerOf: ownerOfReq("doctor"),
    read: [aclController.useDoctor("readPayroll"), doctorController.requireLicenseModule("payroll")],
    write: [aclController.useDoctor("managePayroll"), doctorController.requireLicenseModule("payroll")],
  }),
);

// Noyan Business CRM and SMS campaigns (2026-10, Lib/business/crm.ts and
// campaign.ts): patients and customers, follow-ups, campaigns. Read with
// readCrm, write with manageCrm, submit a campaign with sendCampaigns; the
// plan's "crm" module opens it.
router.use(
  "/crm",
  crmRouter({
    ownerOf: ownerOfReq("doctor"),
    read: [aclController.useDoctor("readCrm"), doctorController.requireLicenseModule("crm")],
    write: [aclController.useDoctor("manageCrm"), doctorController.requireLicenseModule("crm")],
    send: [aclController.useDoctor("sendCampaigns"), doctorController.requireLicenseModule("crm")],
  }),
);

// the panel's one approval queue («کارتابل», 2026-10): finance requests,
// sales approvals, returns and workflow steps (Routers/kartablRoutes.ts)
router.use("/kartabl", kartablRouter({ ownerOf: ownerOfReq("doctor"), member: aclController.useDoctor() }));

// Noyan Business Moadian (2026-10, Lib/moadian): the electronic invoice
// link (key, memory id, item ids) and the invoices made from paid visits
// and sales. Read with readMoadian, change with manageMoadian; the plan's
// "moadian" module opens it.
router.use(
  "/moadian",
  moadianRouter({
    ownerOf: ownerOfReq("doctor"),
    read: [aclController.useDoctor("readMoadian"), doctorController.requireLicenseModule("moadian")],
    write: [aclController.useDoctor("manageMoadian"), doctorController.requireLicenseModule("moadian")],
  }),
);

export default router;
