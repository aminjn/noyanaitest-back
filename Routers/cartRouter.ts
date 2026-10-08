import express from "express";
import * as authcontroller from "../Controllers/authController";
import * as cartController from "../Controllers/cartController";
import * as labSamplingController from "../Controllers/labSamplingController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.use(authcontroller.protect);

router.route("/").get(cartController.getMyCart).put(cartController.clearCart);

router.route("/size").get(cartController.getCartSize);

router.route("/summary").get(cartController.getCartSummary);

// the free lab sampling slots / home windows for checkout (2026-10)
router.route("/sampling/slots").get(labSamplingController.getSamplingSlots);

router
  .route("/item")
  .post(uploadController.upload.none(), cartController.mutateCartItem)
  .put(uploadController.upload.none(), cartController.removeCartItem);

// a photo / PDF of a paper prescription, before checkout (2026-10)
router
  .route("/prescription")
  .post(uploadController.upload.single("file"), cartController.uploadPrescriptionFile);

router
  .route("/submit")
  .post(uploadController.upload.none(), cartController.submitCart);

export default router;
