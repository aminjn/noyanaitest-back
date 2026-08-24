import express from "express";
import * as authcontroller from "../Controllers/authController";
import * as cartController from "../Controllers/CartController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.use(authcontroller.protect);

router.route("/").get(cartController.getMyCart).put(cartController.clearCart);

router.route("/size").get(cartController.getCartSize);

router
  .route("/item")
  .post(uploadController.upload.none(), cartController.mutateCartItem)
  .put(uploadController.upload.none(), cartController.removeCartItem);

router
  .route("/submit")
  .post(uploadController.upload.none(), cartController.submitCart);

export default router;
