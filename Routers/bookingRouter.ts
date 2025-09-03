import express from "express";
import * as authController from "../Controllers/authController";
import * as bookingController from "../Controllers/bookingController";

const router = express.Router();

router
  .route("/book")
  .post(authController.protect, bookingController.submitABooking);

export default router;
