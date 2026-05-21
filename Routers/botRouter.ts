import express from "express";

import * as authController from "../Controllers/authController";

import * as botController from "../Controllers/botController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.use(authController.protect);

router.route("/chat").get(botController.getMyChats);

router.route("/chat/:nodeId").get(botController.getMyChat);

router.route("/prompt").get(botController.prompt);

router.route("/prompt/:nodeId").get(botController.prompt);

export default router;
