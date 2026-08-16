import express from "express";

import * as authController from "../Controllers/authController";
import * as pharmacyController from "../Controllers/pharmacyController";
import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router({ mergeParams: true });

router.use(authController.protect);

router
  .route("/")
  .get(aclController.usePharmacy(), pharmacyController.getMyPharmacyProfile)
  .post(uploadController.upload.none(), pharmacyController.becomeAPharmacy);

router.route("/request").get(pharmacyController.getMyBecomePharmacyRequest);

router
  .route("/prescription")
  .get(aclController.usePharmacy(), pharmacyController.getCachedPrescriptions)
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getPatientPrescriptions,
  )
  .put(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.fillPrescription,
  );

router
  .route("/filledPrescription")
  .get(aclController.usePharmacy(), pharmacyController.getFilledPrescriptions);

router
  .route("/filledPrescription/:nodeId")
  .get(aclController.usePharmacy(), pharmacyController.getFilledPrescription);

router
  .route("/drug")
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getDrugEquiv,
  );

router
  .route("/product")
  .get(aclController.usePharmacy(), pharmacyController.getAvailableProducts);

router
  .route("/myProduct")
  .get(aclController.usePharmacy(), pharmacyController.getMyProducts)
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.addMyProduct,
  );

router
  .route("/myProduct/:nodeId")
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.editMyProduct,
  )
  .put(aclController.usePharmacy(), pharmacyController.removeMyProduct);

router
  .route("/tamin")
  .get(
    aclController.useAcl(),
    uploadController.upload.none(),
    pharmacyController.getAdditiveDrugs,
  )
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getTaminPrescription,
  )
  .patch(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.preCheckPrescription,
  )
  .put(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.submitPrescription,
  );

router
  .route("/taminn")
  .post(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.getSubmittedPrescInfo,
  )
  .put(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.removePrescription,
  )
  .patch(
    aclController.usePharmacy(),
    uploadController.upload.none(),
    pharmacyController.referrPresc,
  );

export default router;
