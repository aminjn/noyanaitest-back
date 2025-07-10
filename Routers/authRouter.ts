import express from "express";
import * as authController from "../Controllers/authController";

const router = express.Router();

router
  .route("/")
  .post(authController.noUser, authController.enter)
  .patch(authController.noUser, authController.login)
  .get(authController.protect, authController.signout);

export default router;
