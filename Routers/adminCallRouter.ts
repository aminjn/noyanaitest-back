import express from "express";
import * as authController from "../Controllers/authController";
import * as adminCallController from "../Controllers/adminCallController";

// /api/v1/admin/calls - read-only call rooms with their reservation,
// participants, events and recordings (2026-10).
const router = express.Router();

router.use(authController.protect, authController.restrictTo("admin", "notadmin"));

router.get(
  "/",
  authController.hasPermission({ model: "CallRoom", op: "readAll" }),
  adminCallController.listCalls,
);
router.get(
  "/:nodeId",
  authController.hasPermission({ model: "CallRoom", op: "readOne" }),
  adminCallController.getCall,
);

export default router;
