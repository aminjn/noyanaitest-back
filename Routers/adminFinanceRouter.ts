import express from "express";
import * as authController from "../Controllers/authController";
import * as adminFinanceController from "../Controllers/adminFinanceController";
import { AccessLevelModel, AccessOperation } from "../Models/AccessLevel";

// Super admin money back office (2026-10), mounted at /admin/finance by
// Routers/adminRouter.ts (after its list routes): order detail and its
// actions, invoices, the subscriptions overview. Full admins, or staff whose
// access level grants Order / Finance. Writes are recorded by
// auditAdminActions (app.ts); order actions also keep their reason on the
// order (Order.adminNotes).
const router = express.Router();
const staffMay = (model: AccessLevelModel, op: AccessOperation) => [
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model, op }),
];

router.get("/orders/:nodeId", ...staffMay("Order", "readOne"), adminFinanceController.getOrder);
router.post(
  "/orders/:nodeId/cancel",
  ...staffMay("Order", "update"),
  adminFinanceController.cancelOrder,
);
router.post(
  "/orders/:nodeId/lines/:lineId/status",
  ...staffMay("Order", "update"),
  adminFinanceController.setLineStatus,
);
router.post(
  "/orders/:nodeId/lines/:lineId/cancel",
  ...staffMay("Order", "update"),
  adminFinanceController.cancelOrderLine,
);
router.post(
  "/orders/:nodeId/delivery",
  ...staffMay("Order", "update"),
  adminFinanceController.dispatchDelivery,
);
router.post(
  "/orders/:nodeId/delivery/refresh",
  ...staffMay("Order", "update"),
  adminFinanceController.refreshDelivery,
);

router.get("/invoices", ...staffMay("Finance", "readAll"), adminFinanceController.listInvoices);
router.get(
  "/invoices/:nodeId",
  ...staffMay("Finance", "readOne"),
  adminFinanceController.getInvoice,
);

router.get(
  "/subscriptions",
  ...staffMay("Finance", "readAll"),
  adminFinanceController.listSubscriptions,
);

export default router;
