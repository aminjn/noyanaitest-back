import express from "express";

import * as authController from "../Controllers/authController";
import * as notPublicController from "../Controllers/notPublicController";

const router = express.Router();

router
  .route("/:nodeId")
  .get(authController.protect, notPublicController.getFile);

export default router;
