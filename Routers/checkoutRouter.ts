import express from "express";

import * as authController from "../Controllers/authController";
import * as checkoutController from "../Controllers/checkoutController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/invoice/:nodeId")
  .post(
    authController.protect,
    uploadController.upload.none(),
    checkoutController.payInvoice
  )
  .put(
    authController.protect,
    uploadController.upload.none(),
    checkoutController.settleInvoice
  );

export default router;
