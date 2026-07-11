import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as paraClinicController from "../Controllers/paraClinicController";
import * as aclController from "../Controllers/aclController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(
    aclController.useParaClinic(),
    paraClinicController.getMyParaClinicProfile,
  )
  .post(uploadController.upload.none(), paraClinicController.becomeAParaClinic);

router.route("/request").get(paraClinicController.getMyBecomeParaClinicRequest);

export default router;
