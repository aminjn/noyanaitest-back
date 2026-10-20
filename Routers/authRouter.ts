import express from "express";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import { authRateLimit } from "../Lib/authRateLimit";

const router = express.Router();

// per minute; an address may be many people behind one proxy, a phone is one
const sendLimit = authRateLimit("enter", { perIp: 30, perPhone: 5 });
const loginLimit = authRateLimit("login", { perIp: 60, perPhone: 10 });
// sign-up asks the paid identity service (Podium) for every new national code
const signupLimit = authRateLimit("signup", { perIp: 10, perPhone: 3 });

router
  .route("/")
  .post(sendLimit, authController.noUser, authController.enter)
  .patch(loginLimit, authController.noUser, authController.login)
  .get(authController.protect, authController.signout);

router
  .route("/signup")
  .post(
    uploadController.upload.none(),
    signupLimit,
    authController.noUser,
    authController.signup,
  );

export default router;
