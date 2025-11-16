import express from "express";

import * as authController from "../Controllers/authController";
import * as migrationController from "../Controllers/migrationController";

const router = express.Router();

router.use(authController.protect, authController.restrictTo("admin"));

router
  .route("/doctor")
  .post(migrationController.importDoctors)
  .put(migrationController.dropDoctors)
  .patch(migrationController.purgeDoctors)
  .delete(migrationController.dropAllDoctors);

router
  .route("/blog")
  .post(migrationController.importBlogs)
  .put(migrationController.dropBlogs)
  .patch(migrationController.purgeBlogs)
  .delete(migrationController.dropAllBlogs);

router
  .route("/disease")
  .post(migrationController.importDiseases)
  .put(migrationController.dropDiseases)
  .patch(migrationController.purgeDiseases)
  .delete(migrationController.dropAllDiseases);

router
  .route("/drug")
  .post(migrationController.importDrugs)
  .put(migrationController.dropDrugs)
  .patch(migrationController.purgeDrugs)
  .delete(migrationController.dropAllDrugs);

router
  .route("/part")
  .post(migrationController.importParts)
  .put(migrationController.dropParts)
  .patch(migrationController.purgeParts)
  .delete(migrationController.dropAllParts);

router
  .route("/speciality")
  .post(migrationController.importSpecialities)
  .put(migrationController.dropSpecialities)
  .patch(migrationController.purgeSpecialities)
  .delete(migrationController.dropAllSpecialities);

router
  .route("/symptom")
  .post(migrationController.importSymptoms)
  .put(migrationController.dropSymptoms)
  .patch(migrationController.purgeSymptoms)
  .delete(migrationController.dropAllSymptoms);

export default router;
