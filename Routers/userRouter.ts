import express from "express";
import * as userController from "../Controllers/userController";
import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router();

router.route("/").get(authController.protect, userController.getMe);

router.route("/doctor");

export default router;
