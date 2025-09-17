import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as callController from "../Controllers/callController";

const router = express.Router();

router.use(authController.protect);

router.route("/").get(callController.getMyOngoingCalls);

router
  .route("/:nodeId")
  .get(callController.getMyCall)
  .post(uploadController.upload.none(), callController.joinACall)
  .put(uploadController.upload.none(), callController.leaveACall);

export default router;
