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

router.route("/identity").get(userController.getMyIdentity);
// .post(uploadController.upload.none(), userController.getOtherIdentity);

router
  .route("/relative")
  .get(userController.getMyRelatives)
  .post(uploadController.upload.none(), userController.addRelative);

router.route("/wallet").get(userController.getWallet);

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

router.route("/reservation").get(userController.getMyReservations);

router.route("/reservation/:nodeId").get(userController.getMyReservation);

router.route("/notification").get(userController.getMyNotifications);

router
  .route("/notification/unread-count")
  .get(userController.getMyUnreadNotificationsCount);

router
  .route("/notification/read-all")
  .post(userController.markAllMyNotificationsAsRead);

router.route("/notification/:nodeId").get(userController.getMyNotification);

router
  .route("/notification/:nodeId/read")
  .post(userController.markMyNotificationAsRead);

export default router;
