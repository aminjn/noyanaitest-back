import express from "express";
import * as userController from "../Controllers/userController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.use(authController.protect);

router
  .route("/")
  .get(userController.getMe)
  .post(uploadController.upload.single("avatar"), userController.editMe);

router
  .route("/identity")
  .get(userController.getMyIdentity)
  .post(uploadController.upload.none(), userController.getOtherIdentity);

router.route("/vital").get(userController.getMyCurrentVital);

router.route("/vitals").get(userController.getMyVitalHistory);

router
  .route("/medical")
  .get(userController.getMyMedicalDetails)
  .post(uploadController.upload.none(), userController.editMyMedicalDetails);

router.route("/invoice").get(userController.getMyInvoices);

router.route("/invoice/:nodeId").get(userController.getMyInvoice);

router.route("/booking").get(userController.getMyBookings);

router.route("/booking/:nodeId").get(userController.getMyBooking);

export default router;
