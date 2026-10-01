import express from "express";
import * as authController from "../Controllers/authController";
import * as adminReservationController from "../Controllers/adminReservationController";
import { AccessLevelModel } from "../Models/AccessLevel";

// /api/v1/admin/reservations - the appointments back office (2026-10).
// Staff with the "Reservation" access level read and act; full admins always.
const router = express.Router();

// cast: the access model is registered in Models/AccessLevel.ts
// (accessLevelModels); until it is, only full admins pass hasPermission
const MODEL = "Reservation" as AccessLevelModel;

router.use(authController.protect, authController.restrictTo("admin", "notadmin"));

router.get(
  "/",
  authController.hasPermission({ model: MODEL, op: "readAll" }),
  adminReservationController.listReservations,
);
router.get(
  "/:nodeId",
  authController.hasPermission({ model: MODEL, op: "readOne" }),
  adminReservationController.getReservation,
);
router.get(
  "/:nodeId/slots",
  authController.hasPermission({ model: MODEL, op: "update" }),
  adminReservationController.getRescheduleSlots,
);
router.post(
  "/:nodeId/cancel",
  authController.hasPermission({ model: MODEL, op: "update" }),
  adminReservationController.cancelReservationByAdmin,
);
router.post(
  "/:nodeId/refund",
  authController.hasPermission({ model: MODEL, op: "update" }),
  adminReservationController.refundReservationByAdmin,
);
router.post(
  "/:nodeId/resolve",
  authController.hasPermission({ model: MODEL, op: "update" }),
  adminReservationController.resolveReservationByAdmin,
);
router.post(
  "/:nodeId/reschedule",
  authController.hasPermission({ model: MODEL, op: "update" }),
  adminReservationController.rescheduleReservationByAdmin,
);

export default router;
