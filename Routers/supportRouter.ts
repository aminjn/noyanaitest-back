import express from "express";

import * as authController from "../Controllers/authController";
import * as supportController from "../Controllers/supportController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/")
  .get(authController.protect, supportController.getMyTickets)
  .post(
    authController.protect,
    uploadController.upload.none(),
    supportController.submitTicket,
  );

router
  .route("/:nodeId")
  .get(authController.protect, supportController.getMyTicket)
  .post(
    authController.protect,
    uploadController.upload.none(),
    supportController.respondTicket,
  )
  .put(
    authController.protect,
    uploadController.upload.none(),
    supportController.closeTicket,
  );

export default router;
