import express from "express";

import * as authController from "../Controllers/authController";
import * as analyticsController from "../Controllers/analyticsController";
import * as uploadController from "../Controllers/uploadController";
import * as phoneRevealController from "../Controllers/phoneRevealController";

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

// the super admin's «نمایش شماره تماس» report (analytics hub tab)
router
  .route("/phone-reveals")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    phoneRevealController.getPhoneRevealReport,
  );

export default router;
