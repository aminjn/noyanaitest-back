import express from "express";
import * as authController from "../Controllers/authController";
import * as bookingController from "../Controllers/bookingController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/book")
  .post(
    authController.protect,
    uploadController.upload.none(),
    bookingController.submitABooking,
  );

router
  .route("/reserve")
  .post(
    authController.protect,
    uploadController.upload.none(),
    bookingController.submitBookingNew,
  );

export default router;
