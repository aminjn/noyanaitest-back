import express from "express";

import * as authController from "../Controllers/authController";
import * as ollamaController from "../Controllers/ollamaController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router.use(authController.protect, authController.restrictTo("admin"));

// refreshing re-syncs the stored model list: a write, so POST (audited)
router.route("/tags").post(ollamaController.refreshModels);

router
  .route("/model/:nodeId")
  .post(ollamaController.loadModel)
  .put(ollamaController.unloadModel);

router
  .route("/settings/:nodeId")
  .get(ollamaController.getModelSettings)
  .post(
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["stop"]),
    ollamaController.setModelSettings,
  )
  .put(ollamaController.restoreDefaultModelSettings);

export default router;
