import * as visitController from "../Controllers/visitController";
import { getMyPatientDashboard } from "../Controllers/patientDashboardController";
import express from "express";
import * as withdrawalController from "../Controllers/withdrawalController";
import * as userController from "../Controllers/userController";
import * as waitlistController from "../Controllers/waitlistController";
import * as patientInsuranceController from "../Controllers/patientInsuranceController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import { userCrmRouter } from "../Controllers/userCrmController";

const router = express.Router();

router.use(authController.protect);

router
  .route("/")
  .get(userController.getMe)
  .post(uploadController.upload.single("avatar"), userController.editMe);

router.route("/dashboard").get(getMyPatientDashboard);

// the centres' CRM, the patient's side: my clubs, my requests to centres
// (2026-10, Controllers/userCrmController.ts)
router.use("/crm", userCrmRouter);

router
  .route("/identity")
  .get(userController.getMyIdentity)
  .post(uploadController.upload.none(), userController.completeMyIdentity);
// .post(uploadController.upload.none(), userController.getOtherIdentity);

router
  .route("/relative")
  .get(userController.getMyRelatives)
  .post(uploadController.upload.none(), userController.addRelative);

// «بیمه‌های من» (Lib/patientInsurances.ts)
router
  .route("/insurances")
  .get(patientInsuranceController.getMyInsurances)
  .put(patientInsuranceController.saveMyInsurances);

router.route("/wallet").get(userController.getWallet);

// wallet -> bank withdrawals (every user: patient refunds, provider payouts)
router
  .route("/withdrawal")
  .get(withdrawalController.getMyWithdrawals)
  .post(uploadController.upload.none(), withdrawalController.createWithdrawal);
router.route("/withdrawal/:nodeId").put(withdrawalController.cancelMyWithdrawal);

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

// «وقتی نوبت خالی شد خبرم کن» (Lib/waitlist.ts)
router.route("/waitlist").get(waitlistController.getMyWaitlist).post(waitlistController.joinWaitlist);
router.route("/waitlist/:nodeId").delete(waitlistController.leaveWaitlist);
// the one-tap "move my appointment" of an earlier-slot offer
router.route("/waitlist/:nodeId/move").post(waitlistController.moveToOffer);

router.route("/reservation/:nodeId").get(userController.getMyReservation);
router
  .route("/reservation/:nodeId/feedback")
  .get(userController.getMyVisitFeedback)
  .post(uploadController.upload.none(), userController.submitMyVisitFeedback);
router
  .route("/reservation/:nodeId/cancel")
  .post(uploadController.upload.none(), userController.cancelMyReservation);
// moving a pending visit to another free slot (inside the free-change window)
router
  .route("/reservation/:nodeId/reschedule")
  .post(userController.rescheduleMyReservation);
// objecting to an in-person visit counted as done without a check-in
router
  .route("/reservation/:nodeId/dispute")
  .post(userController.disputeMyReservation);

router
  .route("/reservation/:nodeId/intake")
  .get(visitController.getMyIntake)
  .put(visitController.saveMyIntake);

router.route("/order").get(userController.getMyOrders);

router.route("/order/:nodeId").get(userController.getMyOrder);
router.route("/order/:nodeId/cancel").post(userController.cancelMyOrder);
// a lab sampling appointment of the order (2026-10, Lib/labSamplingReschedule.ts)
router.route("/order/:nodeId/sampling/:samplingId/reschedule").post(userController.rescheduleMySampling);
router.route("/order/:nodeId/sampling/:samplingId/cancel").post(userController.cancelMySampling);

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
  )
  .delete(userController.deleteMyAddress);

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
