import express from "express";

import * as authController from "../Controllers/authController";

import * as botController from "../Controllers/botController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.use(authController.protect);

router.route("/chat").get(botController.getMyChats);

router
  .route("/chat/:nodeId")
  .get(botController.getMyChat)
  .delete(botController.deleteMyChat);

router.route("/chat/:nodeId/details").get(botController.getMyChatDetails);

// POST, not GET: prompts are user-authored text (can be long, contain "&",
// "%", newlines, etc.) and don't belong url-encoded onto a query string.
router.route("/prompt").post(botController.prompt);

router.route("/prompt/:nodeId").post(botController.prompt);

export default router;
