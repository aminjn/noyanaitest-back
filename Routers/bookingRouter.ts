import express from "express";
import * as authController from "../Controllers/authController";
import * as bookingController from "../Controllers/bookingController";
import * as uploadController from "../Controllers/uploadController";
import { patientReservationView } from "../Lib/patientReservationView";

const router = express.Router();

// the booking quote and the finalized reservation go to the patient: no
// doctor/centre insurer split in them (Lib/patientReservationView.ts)
router.use(patientReservationView);

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

router
  .route("/quote")
  .post(authController.protect, bookingController.getBookingQuote);

export default router;
