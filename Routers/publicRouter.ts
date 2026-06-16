import express from "express";

import * as publicController from "../Controllers/publicController";

import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.route("/redirect").get(publicController.getRedirect);

router.route("/site").get(publicController.getSite);

router.route("/home").get(publicController.getHome);

router
  .route("/specialityDoctors/:nodeId")
  .get(publicController.getSpecialityDoctors);

router.route("/blog").get(publicController.getBlogs);

router.route("/blog/:nodeId").get(publicController.getBlog);

router.route("/selectspeciality").get(publicController.getSpecialityOptions);

router.route("/booking").get(publicController.getBookingPage);

router.route("/dr/:nodeId/id").get(publicController.getDoctorProfileById);

router.route("/dr/:slug").get(publicController.getDoctorProfile);

router
  .route("/doctor/:nodeId/week")
  .get(publicController.getUpcomingWeekAvailabelSessions);

router
  .route("/doctor/:nodeId/day/:stamp")
  .get(publicController.getAvailableSessionsByDay);

router.route("/doctor/:nodeId/config").get(publicController.getDoctorConfig);

router
  .route("/doctor/:nodeId/session")
  .post(
    uploadController.upload.none(),
    publicController.getFirstAvailableSession,
  );

router.route("/session/:nodeId").get(publicController.getSessionDetails);

router
  .route("/map")
  .post(uploadController.upload.none(), publicController.searchInMap);

router.route("/shortlink/:token").get(publicController.getShortLink);

router.route("/doctor").get(publicController.getDoctors);

router.route("/doctor/:slug").get(publicController.getDoctor);

router.route("/speciality").get(publicController.getSpecialities);

router.route("/speciality/:slug").get(publicController.getSpeciality);

router.route("/symptom").get(publicController.getSymptoms);

router.route("/symptom/:slug").get(publicController.getSymptom);

router.route("/disease").get(publicController.getDiseases);

router.route("/disease/:slug").get(publicController.getDisease);

router.route("/drug").get(publicController.getDrugs);

router.route("/drug/:slug").get(publicController.getDrug);

router.route("/insurance/:nodeId").get(publicController.getInsurance);

router
  .route("/doctorinsurance/:nodeId")
  .get(publicController.getDoctorInsurance);

router.route("/office/:nodeId").get(publicController.getOffice);

router.route("/search/clinic").get(publicController.searchClinics);

router.route("/search/speciality").get(publicController.searchSpecialities);

router.route("/search/disease").get(publicController.searchDiseases);

router
  .route("/search/serviceCategory")
  .get(publicController.searchServiceCategories);

router.route("/filterBooking").get(publicController.filterBooking);

router.route("/resolveLocation").get(publicController.resolveLocation);

export default router;
