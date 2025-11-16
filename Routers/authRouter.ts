import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router
  .route("/")
  .post(authController.noUser, authController.enter)
  .patch(authController.noUser, authController.login)
  .get(authController.protect, authController.signout);

router
  .route("/signup")
  .post(
    authController.noUser,
    uploadController.upload.none(),
    authController.signup
  );

export default router;
