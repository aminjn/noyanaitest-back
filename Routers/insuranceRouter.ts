import express from "express";
import * as authController from "../Controllers/authController";
import * as insuranceController from "../Controllers/InsuracneController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.useInsurance(), insuranceController.getMyInsuranceProfile)
  .post(uploadController.upload.none(), insuranceController.becomeAInsurance);

router.route("/request").get(insuranceController.getMyBecomeInsuranceRequest);

export default router;
