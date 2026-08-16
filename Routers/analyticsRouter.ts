import express from "express";

import * as authController from "../Controllers/authController";
import * as analyticsController from "../Controllers/analyticsController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/visit")
  .post(
    authController.optionalAuth,
    uploadController.upload.none(),
    analyticsController.trackVisit,
  );

router
  .route("/summary")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    analyticsController.getAnalyticsSummary,
  );

export default router;
