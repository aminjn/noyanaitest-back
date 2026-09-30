import * as translationController from "../Controllers/translationController";
import express from "express";

import * as publicController from "../Controllers/publicController";

import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.route("/redirect").get(publicController.getRedirect);

router.route("/site").get(publicController.getSite);
router.route("/texts").get(translationController.getPublicTexts);
router.route("/locales").get(translationController.getPublicLocales);

router
  .route("/reportMissingContentKey")
  .post(publicController.reportMissingContentKey);

router.route("/home").get(publicController.getHome);

router.route("/header").get(publicController.getHeader);

router
  .route("/specialityDoctors/:nodeId")
  .get(publicController.getSpecialityDoctors);

router
  .route("/blog")
  .get(publicController.getBlogs)
  .post(uploadController.upload.none(), publicController.submitBlogRRS);

router.route("/blog/:nodeId").get(publicController.getBlog);

router.route("/selectspeciality").get(publicController.getSpecialityOptions);

router
  .route("/selectparaclinictag")
  .get(publicController.getParaClinicTagOptions);

router.route("/selectclinictag").get(publicController.getClinicTagOptions);

router.route("/selecthospitaltag").get(publicController.getHospitalTagOptions);

router
  .route("/selectinsurancetag")
  .get(publicController.getInsuranceTagOptions);

router
  .route("/insuranceCategory")
  .get(publicController.getInsuranceCategoryOptions);

router
  .route("/selectservicecategory")
  .get(publicController.getServiceCategoryOptions);


router.route("/dr/:nodeId/id").get(publicController.getDoctorProfileById);

router
  .route("/dr/:nodeId/availability")
  .get(publicController.getDoctorAvailabilities);

router.route("/dr/:slug").get(publicController.getDoctorProfile);

router
  .route("/doctor/:nodeId/week")
  .get(publicController.getUpcomingWeekAvailabelSessions);

router
  .route("/doctor/:nodeId/day/:stamp")
  .get(publicController.getAvailableSessionsByDay);

router.route("/doctor/:nodeId/config").get(publicController.getDoctorConfig);
router
  .route("/doctor/:nodeId/feedbacks")
  .get(publicController.getDoctorFeedbacks);

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


router.route("/doctor/:slug").get(publicController.getDoctor);

router.route("/speciality").get(publicController.getSpecialities);

router.route("/speciality/:slug").get(publicController.getSpeciality);

router.route("/symptom").get(publicController.getSymptoms);

router.route("/symptom/:slug").get(publicController.getSymptom);

router.route("/disease").get(publicController.getDiseases);

router.route("/disease/:slug").get(publicController.getDisease);

router.route("/drug").get(publicController.getDrugs);

router.route("/drug/:slug").get(publicController.getDrug);

router.route("/clinic").get(publicController.getClinics);

router.route("/clinic/:slug").get(publicController.getClinic);

router.route("/hospital").get(publicController.getHospitals);

router.route("/hospital/:slug").get(publicController.getHospital);

router.route("/paraClinic").get(publicController.getParaClinics);

router.route("/paraClinic/:slug").get(publicController.getParaClinic);

router.route("/test").get(publicController.getTests);

router.route("/service").get(publicController.getServices);

router.route("/service/:slug").get(publicController.getService);

router.route("/servicePackage/:slug").get(publicController.getServicePackage);

router.route("/product").get(publicController.getProducts);

router.route("/product/:slug").get(publicController.getProduct);

router.route("/productPackage/:slug").get(publicController.getProductPackage);

router.route("/insurance").get(publicController.getInsurances);

router.route("/insurance/:nodeId").get(publicController.getInsurance);

router.route("/faq").get(publicController.getFaqs);

router
  .route("/bookingDescription")
  .get(publicController.getBookingDescriptions);

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

router.route("/search/global").get(publicController.globalSearch);
router.route("/inlineAd/:nodeId").get(publicController.getInlineAd);

router.route("/filterBooking2").get(publicController.filterBooking2);
router
  .route("/pharmacy/:slug")
  .get(publicController.getPharmacy);
router
  .route("/filterBookingPharmacy")
  .get(publicController.filterBookingPharmacy);

router.route("/filterBookingClinic").get(publicController.filterBookingClinic);

router.route("/resolveLocation").get(publicController.resolveLocation);

router.route("/searchZones").get(publicController.searchZones);

router.route("/province").get(publicController.getProvinces);
router.route("/city").get(publicController.getCities);
router.route("/district").get(publicController.getDistricts);

router.route("/productCategory").get(publicController.getProductCategories);
router.route("/clinicCategory").get(publicController.getClinicCategories);
router.route("/hospitalCategory").get(publicController.getHospitalCategories);
router
  .route("/paraClinicCategory")
  .get(publicController.getParaClinicCategories);

router
  .route("/contact")
  .post(uploadController.upload.none(), publicController.submitAContactRequest);

router.route("/policy").get(publicController.getPolicy);

router.route("/privacy").get(publicController.getPrivacy);

router.route("/about").get(publicController.getAbout);

router.route("/onboarding").get(publicController.getOnboarding);

router.route("/pagemeta/list").get(publicController.getListPageMeta);

router.route("/pagemeta/node").get(publicController.getNodePageMeta);

router.route("/advertisement/position").get(publicController.getAdvertisements);

router.route("/sitemap/:type/count").get(publicController.getSitemapNodeCount);

router.route("/sitemap/:type").get(publicController.getSitemapNodes);

export default router;
