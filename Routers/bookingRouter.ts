import express from "express";
import * as authController from "../Controllers/authController";
import * as bookingController from "../Controllers/bookingController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

// POST /book (System A: submitABooking) was removed per F-01 - the old
// /doctors and /dr booking flow has been retired in favor of /reserve
// (System B: submitBookingNew). See AUDIT/FIXES_TODO.md F-01.

router
  .route("/reserve")
  .post(
    authController.protect,
    uploadController.upload.none(),
    bookingController.submitBookingNew,
  );

export default router;
