import express from "express";

import * as authController from "../Controllers/authController";
import * as aclController from "../Controllers/aclController";
import { requireOrgLicenseModule } from "../Controllers/orgLicenseGate";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router.route("/").get(aclController.useAcl(), aclController.getMyCurrentAcl);

router
  .route("/acl")
  .get(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.getMyAcls)
  .post(
    aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"),
    uploadController.upload.none(),
    aclController.createAcl,
  );

router
  .route("/acl/:nodeId")
  .post(
    aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"),
    uploadController.upload.none(),
    aclController.editAcl,
  )
  .put(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.deleteAcl);

router
  .route("/secretaryrequest")
  .get(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.getMySecretaryRequests)
  .post(
    aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"),
    uploadController.upload.none(),
    aclController.submitASecretaryRequest,
  );

router
  .route("/secretaryrequest/:nodeId")
  .post(
    aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"),
    uploadController.upload.none(),
    aclController.editSecretaryRequest,
  )
  .delete(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.cancelSecretaryRequest);

router
  .route("/secretary")
  .get(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.getMySecretaries);

router
  .route("/secretary/:nodeId")
  .post(
    aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"),
    uploadController.upload.none(),
    aclController.editMySecretary,
  )
  .put(aclController.useAcl(true),
    requireOrgLicenseModule("secrataries"), aclController.deleteMySecretary);

export default router;
