import express from "express";
import * as userController from "../Controllers/userController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router.route("/").get(authController.protect, userController.getMe);

router
  .route("/invoice")
  .get(authController.protect, userController.getMyInvoices);

router
  .route("/invoice/:nodeId")
  .get(authController.protect, userController.getMyInvoice);

router
  .route("/booking")
  .get(authController.protect, userController.getMyBookings);

router
  .route("/booking/:nodeId")
  .get(authController.protect, userController.getMyBooking);

export default router;
