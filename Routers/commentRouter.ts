import express from "express";

import * as authController from "../Controllers/authController";
import * as commentController from "../Controllers/commentController";

const router = express.Router();

router
  .route("/:name/:nodeId")
  .get(commentController.getComments)
  .post(authController.protect, commentController.submitAComment);

export default router;
