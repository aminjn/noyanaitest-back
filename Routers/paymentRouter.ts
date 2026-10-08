import express from "express";
import * as authController from "../Controllers/authController";
import * as paymentController from "../Controllers/paymentController";
import * as uploadController from "../Controllers/uploadController";
import { patientReservationView } from "../Lib/patientReservationView";

const router = express.Router();

// SEP's post-payment redirect - public (identified by ResNum, not by the
// session cookie) and form-encoded, so it's registered before `protect`
// with its own urlencoded parser.
router
  .route("/sep/callback")
  .post(express.urlencoded({ extended: false }), paymentController.sepCallback)
  .get(paymentController.sepCallback);

router.use(authController.protect);
// a payment's result may carry the reservation it paid for
router.use(patientReservationView);

router.route("/config").get(paymentController.getPaymentConfig);

router
  .route("/wallet/charge")
  .post(uploadController.upload.none(), paymentController.chargeWallet);

router.route("/:nodeId").get(paymentController.getMyPayment);

export default router;
