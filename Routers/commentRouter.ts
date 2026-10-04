import express from "express";

import * as authController from "../Controllers/authController";
import * as commentController from "../Controllers/commentController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/:nodeId")
  .post(authController.protect, commentController.toggleVote);

// can the signed-in user leave a verified review here (and why not)
router
  .route("/:name/:nodeId/eligibility")
  .get(authController.protect, commentController.getCommentEligibility);

router
  .route("/:name/:nodeId")
  .get(commentController.getComments)
  .post(
    authController.protect,
    uploadController.upload.none(),
    commentController.submitAComment,
  );

export default router;
