import express from "express";
import { devToolsGuard } from "../Lib/devToolsGuard";

import * as authController from "../Controllers/authController";
import * as migrationController from "../Controllers/migrationController";

const router = express.Router();

router.use(authController.protect, authController.restrictTo("admin"));
// Import (POST) and reading its progress (GET) are safe; the drop/purge
// verbs wipe whole collections, so on a live server they are off unless the
// operator opts in for one session.
router.use(devToolsGuard((req) => req.method !== "POST" && req.method !== "GET"));

// everything, in dependency order, as a background job (GET = its progress)
router
  .route("/all")
  .post(migrationController.startImportAll)
  .get(migrationController.getImportJob);

// accounts: import only (no drop verbs - they are people's logins)
router.route("/user").post(migrationController.importUsers);

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
