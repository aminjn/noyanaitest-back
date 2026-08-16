import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as callController from "../Controllers/callController";

const router = express.Router();

router.use(authController.protect);

router.route("/").get(callController.getMyOngoingCalls);

// Literal paths must be registered before "/:nodeId" so they aren't
// swallowed by the single-segment param route below.
router.route("/history").get(callController.getMyCallHistory);

router
  .route("/booking/:bookingId")
  .post(uploadController.upload.none(), callController.createCallFromBooking);

router
  .route("/:nodeId")
  .get(callController.getMyCall)
  .delete(callController.endCall);

router
  .route("/:nodeId/answer")
  .post(uploadController.upload.none(), callController.answerCall);

router
  .route("/:nodeId/reject")
  .post(uploadController.upload.none(), callController.rejectCall);

router
  .route("/:nodeId/leave")
  .put(uploadController.upload.none(), callController.leaveCall);

router
  .route("/:nodeId/kick")
  .post(uploadController.upload.none(), callController.kickParticipant);

router
  .route("/:nodeId/mute")
  .post(uploadController.upload.none(), callController.muteParticipant);

router
  .route("/:nodeId/recording/start")
  .post(uploadController.upload.none(), callController.startRecording);

router
  .route("/:nodeId/recording/stop")
  .post(uploadController.upload.none(), callController.stopRecording);

router.route("/:nodeId/recordings").get(callController.listRecordings);

export default router;
