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

router
  .route("/tamin")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.getPrescs,
  )
  .patch(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.precheckPrescription,
  )
  .put(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.submitPrescription,
  );

router
  .route("/taminn")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.getPrescription,
  )
  .put(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.deletePrescription,
  )
  .patch(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.registerDiagnosis,
  );

router
  .route("/icid")
  .get(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.getIcids,
  );

router
  .route("/tamin/physio")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.registerPhysioSession,
  );

router
  .route("/tamin/session")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.registerPhysioSession,
  );

export default router;
