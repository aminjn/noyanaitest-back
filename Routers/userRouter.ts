import express from "express";
import * as userController from "../Controllers/userController";
import * as authController from "../Controllers/authController";

const router = express.Router();

router.route("/").get(authController.protect, userController.getMe);

export default router;
