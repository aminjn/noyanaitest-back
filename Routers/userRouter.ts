import * as visitController from "../Controllers/visitController";
import { getMyPatientDashboard } from "../Controllers/patientDashboardController";
import express from "express";
import * as userController from "../Controllers/userController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router.use(authController.protect);

router
  .route("/")
  .get(userController.getMe)
  .post(uploadController.upload.single("avatar"), userController.editMe);

router.route("/dashboard").get(getMyPatientDashboard);

router.route("/identity").get(userController.getMyIdentity);
// .post(uploadController.upload.none(), userController.getOtherIdentity);

router
  .route("/relative")
  .get(userController.getMyRelatives)
  .post(uploadController.upload.none(), userController.addRelative);

router.route("/wallet").get(userController.getWallet);

router.route("/transaction").get(userController.getMyTransactions);

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

router
  .route("/reservation/:nodeId/intake")
  .get(visitController.getMyIntake)
  .put(visitController.saveMyIntake);

router.route("/order").get(userController.getMyOrders);

router.route("/order/:nodeId").get(userController.getMyOrder);

router
  .route("/address")
  .get(userController.getMyAddresses)
  .post(
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["location"]),
    userController.createMyAddress,
  );

router
  .route("/address/:nodeId")
  .get(userController.getMyAddress)
  .post(
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["location"]),
    userController.editMyAddress,
  );

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

router.route("/push/publicKey").get(userController.getPushPublicKey);

router.route("/push/subscribe").post(userController.subscribeToPush);

router.route("/push/unsubscribe").post(userController.unsubscribeFromPush);

export default router;
