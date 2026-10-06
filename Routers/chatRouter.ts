import express from "express";

import * as authController from "../Controllers/authController";
import * as chatController from "../Controllers/chatController";
import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.route("/").get(authController.protect, chatController.getMyChats);

// before "/:nodeId", which would take "unread" for an id
router.route("/unread").get(authController.protect, chatController.getMyUnreadCount);

router
  .route("/:nodeId")
  .get(authController.protect, chatController.getMyChat)
  .post(
    authController.protect,
    uploadController.upload.single("file"),
    chatController.sendMessage
  );

router
  .route("/message/:nodeId")
  .get(authController.protect, chatController.getMessage);

export default router;
