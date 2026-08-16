import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as paraClinicController from "../Controllers/paraClinicController";
import * as aclController from "../Controllers/aclController";
import * as autoController from "../Controllers/autoController";

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
  .route("/profile")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "paraClinic" }),
    autoController.mutateCompoundFields(["tags", "insurances", "location"]),
    paraClinicController.updateMyParaClinicProfile,
  );

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
  .route("/test")
  .get(
    aclController.useParaClinic(),
    paraClinicController.getAvailableTests,
  );

router
  .route("/myTest")
  .get(aclController.useParaClinic(), paraClinicController.getMyTests)
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.addMyTest,
  );

router
  .route("/myTest/:nodeId")
  .post(
    aclController.useParaClinic(),
    uploadController.upload.none(),
    paraClinicController.editMyTest,
  )
  .put(aclController.useParaClinic(), paraClinicController.removeMyTest);

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
